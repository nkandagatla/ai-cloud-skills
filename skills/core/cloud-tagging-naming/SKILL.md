---
name: cloud-tagging-naming
description: Naming conventions and tagging/labelling standards for AWS, Azure and GCP, with enforcement (tag policies, Azure Policy, org policy/labels in IaC) and cost allocation. Use when naming new resources, adding tags in IaC, auditing untagged resources, or setting up cost allocation.
---

# Cloud Tagging and Naming

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Tags/labels power cost allocation, ownership, automation (backup selection, patching, auto-remediation scope), access control (ABAC) and incident response ("whose is this?"). Names should tell a human what a resource is without opening it.

Read the standard from `CLOUD.md` if present. Otherwise propose this default and ask the user to adopt or adjust it.

## Default tag set

| Key | Example | Required | Purpose |
| --- | --- | --- | --- |
| `owner` | `team-payments` | Yes | Accountable team (not a person) |
| `env` | `prod` / `stage` / `dev` / `sbx` | Yes | Environment tier |
| `app` | `checkout-api` | Yes | Application / workload |
| `cost-center` | `cc-1042` | Yes | Finance allocation |
| `data-classification` | `public` / `internal` / `confidential` / `restricted` | Yes for data stores | Drives encryption/access controls |
| `managed-by` | `terraform` / `bicep` / `cdk` / `manual` | Yes | Where to change it |
| `repo` | `github.com/acme/infra` | Recommended | Source of truth |
| `backup` | `gold` / `silver` / `none` | Stateful resources | Backup plan selection |
| `expires-on` | `2026-12-31` | Sandbox / temporary | Cleanup automation |
| `compliance` | `pci` / `hipaa` | When in scope | Scope evidence |

Rules: lowercase keys and values, hyphens not spaces, no secrets or personal data in tags (tags are visible widely and appear in billing exports). GCP label keys/values: lowercase letters, digits, `_` and `-`, max 63 chars. Azure tag names are case-insensitive, values case-sensitive; some characters (`<>%&\?/`) are not allowed in names.

## Naming convention

Pattern: `<org>-<app>-<component>-<env>-<region-short>-<nn>` with cloud-specific constraints.

| Resource | AWS | Azure (CAF abbreviations) | GCP |
| --- | --- | --- | --- |
| Network | `acme-core-vpc-prod-use1` | `vnet-core-prod-eastus-01` | `acme-core-vpc-prod` |
| Subnet | `acme-core-snet-app-prod-use1a` | `snet-app-prod-eastus-01` | `acme-core-snet-app-prod-usc1` |
| Cluster | `acme-eks-prod-use1` | `aks-platform-prod-eastus-01` | `acme-gke-prod-usc1` |
| Storage | `acme-checkout-logs-prod-use1-111122223333` (global, add account id) | `stcheckoutprodeus01` (3-24, lowercase alnum, global) | `acme-checkout-logs-prod` (global) |
| Key store | `alias/acme-checkout-prod` | `kv-checkout-prod-eus-01` (3-24, global) | keyring `acme-checkout-prod` |
| Resource group / project | — | `rg-checkout-prod-eastus` | project id `acme-checkout-prod` (6-30, immutable) |

Globally unique names (S3, Azure storage/Key Vault/ACR, GCS, GCP project ids) must not be guessable for sensitive data and must not contain secrets.

## Implement in IaC

Terraform AWS: provider-level default tags.

```hcl
provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
}
locals {
  tags = {
    owner = var.owner, env = var.env, app = var.app,
    cost-center = var.cost_center, managed-by = "terraform", repo = "github.com/acme/infra"
  }
}
```

Terraform Azure: no provider default tags; pass `tags = local.tags` to every resource (modules should accept `tags`). Terraform GCP: `provider "google" { default_labels = local.labels }`.

Bicep: `param tags object` passed to every resource; or Azure Policy "Inherit a tag from the resource group" (modify effect).

CDK: `Tags.of(app).add('owner', 'team-payments')`.

## Enforce

| | Preventive | Detective |
| --- | --- | --- |
| AWS | Tag policies (Organizations) for allowed values + SCP `aws:RequestTag`/`aws:TagKeys` deny on create for key resource types | AWS Config `required-tags` rule; Resource Groups Tag Editor |
| Azure | Azure Policy `deny` "Require a tag and its value on resources" / on resource groups; `modify` to inherit from RG | Policy compliance state |
| GCP | Org policy constraints on labels are limited; enforce in IaC + policy-as-code; use **Tags** (resource manager tags) for policy conditions | Cloud Asset Inventory query for missing labels |
| All | Conftest/Checkov rule on plan (see `policy-as-code`) | |

Activate cost allocation: AWS Billing → cost allocation tags (activate user-defined keys); Azure Cost Management tag inheritance setting; GCP labels flow to billing export automatically.

## Audit untagged resources (read-only)

```bash
# AWS (per region)
aws resourcegroupstaggingapi get-resources --query "ResourceTagMappingList[?!(Tags[?Key=='owner'])].ResourceARN" --output text

# Azure (Resource Graph)
az graph query -q "resources | where isnull(tags['owner']) or isnull(tags['env']) | project id, type, resourceGroup | limit 200"

# GCP (Cloud Asset Inventory)
gcloud asset search-all-resources --scope=projects/PROJECT --query="NOT labels:owner" --format="table(name,assetType)"
```

Fixing tags on IaC-managed resources happens in IaC. Bulk tagging via CLI (`aws resourcegroupstaggingapi tag-resources`, `az tag update --operation merge`, `gcloud ... update --update-labels`) is a change: follow `cloud-change-plan`, and use `merge`/`update` semantics, never `replace`, so existing tags are kept.
