---
name: policy-as-code
description: Set up and run policy-as-code guardrails for infrastructure - Checkov, Trivy/tfsec, TFLint, OPA/Conftest, cfn-guard, PSRule for Azure, Kyverno/Gatekeeper, pre-commit and CI gates - plus cloud-native preventive controls (SCPs, Azure Policy, GCP Org Policy). Use when adding scanners to a repo or pipeline, writing a custom policy, or triaging policy failures.
---

# Policy as Code

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Three layers, each catching what the previous one missed:

1. **Developer / agent time**: pre-commit hooks and local scans (fast feedback).
2. **Pull request**: CI gate on the plan and code (blocking).
3. **Cloud runtime**: preventive controls in the cloud itself (SCPs / RCPs, Azure Policy `deny`, GCP Org Policy) and admission control in Kubernetes. These are the only layer that also stops humans and console changes.

Agents may add layers 1 and 2 to a repo through a PR. Layer 3 belongs to the platform/security team's repo and is changed only through `cloud-change-plan`.

## Layer 1: pre-commit

`.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.96.1
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
      - id: terraform_tflint
      - id: terraform_checkov
        args: ["--args=--quiet --compact"]
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
  - repo: local
    hooks:
      - id: cloud-guard-scan
        name: cloud-guard secret scan
        entry: node .cloud-guard/bin/cloud-guard.mjs scan
        language: system
        pass_filenames: true
```

Pin `rev` to released tags and update deliberately (`pre-commit autoupdate` in a PR).

## Layer 2: CI gate

Run on the code **and** on the plan JSON (the plan reveals computed values the code hides).

```bash
terraform plan -out=tfplan && terraform show -json tfplan > tfplan.json   # in CI only; artifact is sensitive
checkov -f tfplan.json --framework terraform_plan --compact
trivy config --exit-code 1 --severity HIGH,CRITICAL .
conftest test tfplan.json -p policies/
```

Treat `tfplan.json` as a secret: do not upload as a public artifact, delete after the job.

See `templates/github-actions/iac-checks.yml` in this repo for a complete workflow.

### Suppressions

Allowed only inline, specific and justified, with an expiry or ticket:

```hcl
resource "aws_s3_bucket" "public_site" {
  #checkov:skip=CKV2_AWS_6:Public website bucket served via CloudFront OAC; BPA enforced at account level. SEC-1234
}
```

Never blanket-skip checks in config files, never skip CRITICAL identity/public-access checks without a security sign-off.

## Writing a custom policy (OPA / Conftest, Rego v1)

`policies/tags.rego`:

```rego
package main

import rego.v1

required := {"owner", "env", "cost-center"}

deny contains msg if {
  rc := input.resource_changes[_]
  rc.change.actions[_] in {"create", "update"}
  tags := object.get(rc.change.after, "tags", {})
  missing := required - {k | tags[k]}
  count(missing) > 0
  msg := sprintf("%s is missing required tags: %v", [rc.address, missing])
}

deny contains msg if {
  rc := input.resource_changes[_]
  rc.type == "aws_security_group_rule"
  rc.change.after.type == "ingress"
  "0.0.0.0/0" in rc.change.after.cidr_blocks
  rc.change.after.from_port <= 22
  rc.change.after.to_port >= 22
  msg := sprintf("%s opens SSH to the internet", [rc.address])
}
```

Test policies: `conftest verify -p policies/` with `*_test.rego` files. A policy without tests is not done.

### Checkov custom check (YAML)

```yaml
metadata:
  id: "CKV2_ACME_1"
  name: "Storage accounts must disable shared key access"
  category: "IAM"
definition:
  cond_type: attribute
  resource_types: ["azurerm_storage_account"]
  attribute: shared_access_key_enabled
  operator: equals
  value: false
```

### CloudFormation Guard

```
rule s3_encrypted when %resources.*[ Type == 'AWS::S3::Bucket' ] !empty {
  %resources.*[ Type == 'AWS::S3::Bucket' ].Properties.BucketEncryption exists
}
```

### PSRule for Azure

```bash
Install-Module PSRule.Rules.Azure -Scope CurrentUser
Assert-PSRule -Module PSRule.Rules.Azure -InputPath ./main.bicep -Format File
```
Configure baseline in `ps-rule.yaml` (`Azure.GA_<yyyy>_<mm>` baseline).

## Layer 3: cloud-native preventive controls

| Need | AWS | Azure | GCP |
| --- | --- | --- | --- |
| Region restriction | SCP `aws:RequestedRegion` | Policy "Allowed locations" | Org policy `gcp.resourceLocations` |
| No public storage | S3 account BPA + SCP; RCP for S3 | Policy "Storage accounts should prevent public access" (deny) | `storage.publicAccessPrevention` |
| No long-lived keys | SCP deny `iam:CreateAccessKey` | Policy / Entra app management policy (credential restrictions) | `iam.managed.disableServiceAccountKeyCreation` |
| Protect logging | SCP deny `cloudtrail:StopLogging` etc. | Deny assignments / locks + Policy | Org policy + IAM deny policies |
| Require encryption | SCP condition keys / Config rules | Policy "require CMK" | `gcp.restrictNonCmekServices` |
| Restrict VM external IPs | SCP on `ec2:AssociatePublicIpAddress` + Config | Policy "Network interfaces should not have public IPs" | `compute.vmExternalIpAccess` |

Details per cloud: `aws-organizations-governance`, `azure-policy-governance`, `gcp-org-policy-security`.

Roll out preventive controls in **audit/dry-run mode first** (Azure `Audit` effect, GCP dry-run org policy, AWS test OU), review impact for at least one week, then enforce.

## Kubernetes admission

Kyverno (`validationFailureAction: Audit` first, then `Enforce`) or Gatekeeper constraints for: non-root, no privileged, approved registries, required labels, signed images (see `container-supply-chain`), resource limits. Pod Security Admission `restricted` on app namespaces.

## Triage a failing check

1. Read the check id and documentation link.
2. Determine if it is a true positive. Most are.
3. Fix the code. If a fix is impossible, propose a scoped inline suppression with a reason and ticket, and flag it for the user; never add the suppression silently.
