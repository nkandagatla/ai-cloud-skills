---
name: terraform-workflow
description: Safe day-to-day Terraform/OpenTofu/Terragrunt workflow for AWS, Azure and GCP - repo layout, remote state with locking and encryption, provider/module pinning, plan review, imports, moved/removed blocks, drift detection and state recovery. Use when writing, refactoring, planning or troubleshooting Terraform.
---

# Terraform Workflow

Follow `cloud-guardrails` and `cloud-change-plan`. Agents run `init`, `validate`, `fmt`, `plan`, `show`, `state list/show`. Agents never run `apply -auto-approve`, `destroy`, or `state push`; `apply tfplan` only in sandbox/nonprod after approval.

## Repository layout (recommended)

```
infra/
  modules/                 # reusable, versioned, no provider/backend blocks
    network/  eks/  rds/
  envs/                    # one root module per environment (and region if needed)
    dev/   main.tf  backend.tf  versions.tf  terraform.tfvars
    stage/ ...
    prod/  ...
  policies/                # OPA/Conftest or Checkov custom policies
```

Prefer directories per environment over CLI workspaces for prod separation: different state, different credentials, different approvals. Use workspaces only for short-lived identical copies (feature environments).

## Version pinning

```hcl
terraform {
  required_version = "~> 1.9"
  required_providers {
    aws     = { source = "hashicorp/aws",     version = "~> 5.70" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.5" }
    google  = { source = "hashicorp/google",  version = "~> 6.8" }
  }
}
```

Commit `.terraform.lock.hcl`. Generate hashes for every platform the team uses: `terraform providers lock -platform=windows_amd64 -platform=linux_amd64 -platform=darwin_arm64`.

Modules: `source = "git::https://github.com/org/modules.git//network?ref=v1.4.2"` (tag or commit SHA), or a registry module with `version = "~> 5.1"`. Never an unpinned branch.

## Remote state (encrypted, locked, private)

**AWS (S3 native locking, Terraform 1.10+):**
```hcl
terraform {
  backend "s3" {
    bucket       = "acme-tfstate-111122223333"
    key          = "prod/network/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    kms_key_id   = "alias/tfstate"
    use_lockfile = true          # older versions: dynamodb_table = "tf-locks"
  }
}
```
State bucket: versioning on, Block Public Access, SSE-KMS, bucket policy denying non-TLS and limiting to the CI role and break-glass role, object lock optional.

**Azure:**
```hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "sttfstateacme"
    container_name       = "tfstate"
    key                  = "prod/network.tfstate"
    use_azuread_auth     = true   # no storage keys
  }
}
```
Storage account: `shared_access_key_enabled = false`, versioning + soft delete, private endpoint or restricted network, resource lock `CanNotDelete`.

**GCP:**
```hcl
terraform {
  backend "gcs" {
    bucket = "acme-tfstate"
    prefix = "prod/network"
  }
}
```
Bucket: versioning, uniform bucket-level access, public access prevention, CMEK optional, IAM limited to the CI service account (locking is built in).

State contains secrets in plain text. Never `cat`, upload, paste, or commit it. Never `terraform state pull` into a tracked path.

## The loop

```bash
terraform fmt -recursive
terraform init -input=false            # -upgrade only when intentionally bumping versions
terraform validate
tflint --recursive                     # if installed
terraform plan -input=false -out=tfplan
terraform show tfplan                  # human-readable; summarise for the reviewer
```

Read the plan: count adds / changes / destroys; list every `-/+` (replace) and `-` (destroy) with the reason Terraform gives (`# forces replacement`); flag IAM, network and data changes. Then present per `cloud-change-plan`.

Apply only the saved plan: `terraform apply tfplan`. If the plan is older than the latest commit or state changed, re-plan.

## Refactoring without destroying

- Rename / move into modules: `moved { from = aws_s3_bucket.logs  to = module.logging.aws_s3_bucket.this }`.
- Adopt existing resources: `import { to = aws_s3_bucket.logs  id = "acme-logs" }` then `terraform plan -generate-config-out=generated.tf` (review and clean generated code).
- Stop managing without deleting: `removed { from = aws_instance.legacy  lifecycle { destroy = false } }`.
- Prefer these blocks over `terraform state mv/rm/import` CLI because they are reviewed in the PR.
- Protect critical resources: `lifecycle { prevent_destroy = true }`; ignore fields managed elsewhere with `ignore_changes` (narrowly, with a comment).

## Secrets

- Never put secret values in `.tf` or `.tfvars`. Read them at plan time from the secret store (`data "aws_secretsmanager_secret_version"`), or better, have the service generate and manage them (`manage_master_user_password = true` for RDS, Key Vault references, Secret Manager + Workload Identity).
- Terraform 1.10+ ephemeral values (`ephemeral "aws_secretsmanager_secret_version"`, write-only arguments such as `password_wo` where providers support them) keep secrets out of state; prefer them when available.
- Mark outputs `sensitive = true`; avoid outputting secrets at all.

## Drift

```bash
terraform plan -refresh-only -out=drift.tfplan && terraform show drift.tfplan
```
Report drift as a finding: who changed what (check CloudTrail / Activity Log / Audit Logs), and recommend either codifying it or reverting it via a normal plan. Do not apply `-refresh-only` in prod.

## Troubleshooting

| Symptom | Safe action |
| --- | --- |
| `Error acquiring the state lock` | Find the holder (lock info shows who/when). Confirm no apply is running. Only a human runs `terraform force-unlock <id>`. |
| Provider auth errors | Check identity (`aws sts get-caller-identity`, `az account show`, `gcloud auth list`), the provider `assume_role` / subscription / project. Do not hard-code credentials. |
| Unexpected replacements | Look for changed immutable arguments, provider upgrades, `for_each` key changes; fix with `moved` blocks. |
| Resource exists already | `import` block, never delete-and-recreate prod resources. |
| Corrupted / lost state | Restore a previous object version of the state file (S3 versioning, blob versioning, GCS versioning). Human performs the restore. |

## Terragrunt

Run in a single unit (`terragrunt plan` inside `live/dev/network`). `run-all apply/destroy` is blocked by the guard. Keep `remote_state` generation encrypted and locked as above.

## OpenTofu

Commands are identical with `tofu`. OpenTofu adds client-side state encryption (`terraform { encryption { ... } }`); prefer it when the team uses OpenTofu.
