---
name: gcp-iac
description: Infrastructure as code on Google Cloud - Terraform google/google-beta providers with impersonation and GCS state, Cloud Foundation Fabric and terraform-google-modules, Infrastructure Manager, Config Connector (KRM), Cloud Build/Cloud Deploy pipelines, API enablement, IAM resource types pitfalls, and importing existing resources. Use when writing or reviewing Terraform/KRM for GCP or setting up GCP IaC pipelines.
---

# Google Cloud IaC

Load `cloud-guardrails`, `terraform-workflow`, `iac-security-review`, `cloud-change-plan`.

## 1. Provider configuration (no keys)

```hcl
provider "google" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "tf-deploy-${var.env}@acme-seed.iam.gserviceaccount.com"   # humans impersonate; CI uses WIF directly
  default_labels              = local.labels
  add_terraform_attribution_label = true
}
provider "google-beta" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "tf-deploy-${var.env}@acme-seed.iam.gserviceaccount.com"
  default_labels              = local.labels
}
terraform {
  backend "gcs" {
    bucket                      = "acme-tfstate"
    prefix                      = "prod/orders"
    impersonate_service_account = "tf-deploy-prod@acme-seed.iam.gserviceaccount.com"
  }
}
```

- One deploy SA per environment, in a seed/bootstrap project, with roles granted only on the folders/projects it manages. Humans get `roles/iam.serviceAccountTokenCreator` on the **nonprod** deploy SA only; prod deploy SA is usable only by CI (WIF) and break-glass.
- Never `credentials = file("key.json")`, never `GOOGLE_CREDENTIALS` with a key in CI (`cicd-oidc`).

## 2. Modules

- **Cloud Foundation Fabric** (landing zone stages, opinionated modules) or **terraform-google-modules** (project-factory, network, gke, sql...). Pin versions (`?ref=v36.0.0` / `version = "~> 35.0"`).
- **Project factory** pattern for new projects: billing, folder, labels, APIs, Shared VPC attachment, budget, default SA hardening, essential contacts: all in one reviewed module.

## 3. Pitfalls specific to GCP

| Pitfall | Safe approach |
| --- | --- |
| `google_project_iam_policy` / `google_*_iam_binding` wipe other grants | Use `_iam_member` (additive) by default (`gcp-iam`) |
| `google_project_service` with `disable_on_destroy = true` | Set `disable_on_destroy = false` and `disable_dependent_services = false`; disabling APIs breaks things |
| Eventual consistency after enabling APIs/creating SAs | `depends_on` + `time_sleep` only where needed; retry rather than race |
| Default resources created by APIs (default network, default SA grants) | Org policies prevent them; don't rely on deleting after the fact |
| Resource deletion protection | `deletion_protection = true` on Cloud SQL, GKE, Cloud Run v2, BigQuery tables, Spanner (`enable_drop_protection`); `prevent_destroy` lifecycle on critical resources |
| Labels vs tags | Labels for cost/metadata; **resource manager tags** (`google_tags_tag_binding`) for policy (firewall, org policy conditions, IAM conditions) |
| Beta-only arguments | Use `google-beta` explicitly and pin; beta features may change |
| Project IDs are immutable and global | Generate with a suffix; never reuse deleted IDs |

## 4. Importing existing resources

```hcl
import {
  to = google_storage_bucket.legacy
  id = "acme-legacy-exports"
}
```
`terraform plan -generate-config-out=generated.tf`, then clean and align with standards. Bulk discovery: `gcloud beta resource-config bulk-export --resource-format=terraform --project=P --path=out/` (review output; it can include sensitive values in some resources: keep it out of git until reviewed).

## 5. Infrastructure Manager

Google-managed Terraform runs (`gcloud infra-manager deployments apply` with a dedicated SA, state managed by the service). Preview with `gcloud infra-manager previews create ...` and review before apply. Same guardrails as Terraform; apply is a change.

## 6. Config Connector (KRM in GKE)

- Manage GCP resources as Kubernetes objects (`StorageBucket`, `IAMPolicyMember`, `SQLInstance`) through GitOps.
- Namespaced mode with one GSA per namespace/project; `cnrm.cloud.google.com/deletion-policy: abandon` annotation on critical resources; `IAMPolicyMember` (additive) instead of `IAMPolicy`.
- Policy Controller / Gatekeeper constraints on KRM resources (no public buckets, required labels).

## 7. Pipelines (Cloud Build example)

```yaml
steps:
  - name: hashicorp/terraform:1.9
    entrypoint: sh
    args: ["-c", "terraform init -input=false && terraform validate && terraform plan -input=false -out=tfplan && terraform show -no-color tfplan > plan.txt"]
  - name: bridgecrew/checkov:3
    args: ["-d", ".", "--quiet", "--compact"]
# Apply runs in a separate trigger on main with manual approval (Cloud Build approvals) and the prod deploy SA.
serviceAccount: projects/acme-seed/serviceAccounts/tf-plan-prod@acme-seed.iam.gserviceaccount.com
options: { logging: CLOUD_LOGGING_ONLY }
```

Pin images by digest in real pipelines. Cloud Build triggers: require approval for prod, restrict to protected branches, private pools for VPC-SC environments.

## Never

- Service account key files in providers, backends or CI (guard-blocked creation).
- Authoritative IAM resources on projects/folders/org from app repos.
- `terraform apply -auto-approve` / `destroy` (guard-blocked); disabling APIs via `disable_on_destroy`.
