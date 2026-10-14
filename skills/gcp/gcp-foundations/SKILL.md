---
name: gcp-foundations
description: Google Cloud basics done safely - gcloud auth and configurations, project/folder/organization targeting, service account impersonation, resource hierarchy and landing zone (Cloud Foundation), project baseline (audit logs, org policies, SCC, budgets, APIs), quotas and Cloud Asset Inventory. Use when starting GCP work, auditing a project, or when the target project/account is unclear.
---

# Google Cloud Foundations

Load `cloud-guardrails`. Confirm **account, project and configuration** before every task.

## 1. Authentication and configurations

```bash
gcloud auth login                                # human, browser + 2SV
gcloud auth application-default login            # ADC for SDKs/Terraform (local only)
gcloud config configurations create acme-dev
gcloud config set project acme-orders-dev
gcloud config set compute/region us-central1
# Least privilege: run as a deploy SA via impersonation instead of your own broad roles
gcloud config set auth/impersonate_service_account deploy-dev@acme-orders-dev.iam.gserviceaccount.com
gcloud config configurations list
gcloud config list --format="value(core.account,core.project,auth.impersonate_service_account)"
```

Use one named configuration per environment (`acme-dev`, `acme-prod-readonly`) and pass `--project` explicitly in proposed commands. Impersonation requires `roles/iam.serviceAccountTokenCreator` on that SA (granted to the user's group, through IaC). No service account keys, ever (guard-blocked); `gcloud auth print-access-token` is guard-blocked.

## 2. Resource hierarchy (reference landing zone)

```
Organization (acme.com)
├── fldr-bootstrap         → seed project (Terraform state, CI identities)
├── fldr-common            → logging, monitoring, security (SCC), billing export, DNS hub, networking hub (Shared VPC hosts)
├── fldr-production        → app projects (Shared VPC service projects)
├── fldr-nonproduction
├── fldr-development
└── fldr-sandbox           → budget-capped, isolated, auto-cleanup
```

Build with Cloud Foundation Fabric / terraform-example-foundation (Security Foundations Blueprint). IAM and org policies set at folders are inherited. Governance details: `gcp-org-policy-security`.

## 3. Project baseline checklist (audit read-only)

| Control | Check |
| --- | --- |
| Project in the right folder, labelled | `gcloud projects describe P --format="yaml(parent,labels)"` |
| Billing account linked, budget set | `gcloud billing projects describe P`; `gcloud billing budgets list --billing-account=BA` |
| Audit logs: Admin Activity (always), Data Access for sensitive services | `gcloud projects get-iam-policy P --format=json | jq .auditConfigs` |
| Logs routed to central log bucket / sink (org-level aggregated sink) | `gcloud logging sinks list --organization=ORG` |
| No basic roles (owner/editor) for humans or SAs | `gcloud projects get-iam-policy P --flatten="bindings[].members" --filter="bindings.role:(roles/owner OR roles/editor)" --format="table(bindings.role,bindings.members)"` |
| Default compute SA not used / no Editor grant | org policy `iam.automaticIamGrantsForDefaultServiceAccounts` enforced |
| No user-managed SA keys | `gcloud iam service-accounts list --format="value(email)"` then `keys list --managed-by=user` |
| Org policies effective | `gcloud org-policies list --project=P` |
| SCC enabled (org) and findings reviewed | `gcloud scc findings list organizations/ORG --filter="state=\"ACTIVE\" AND resource.project_display_name=\"P\"" --limit=20` |
| Only needed APIs enabled | `gcloud services list --enabled --project=P` |
| Essential Contacts set | `gcloud essential-contacts list --project=P` |

## 4. Inventory at scale: Cloud Asset Inventory

```bash
gcloud asset search-all-resources --scope=organizations/ORG --asset-types="compute.googleapis.com/Instance" --query="state:RUNNING" --format="table(name,location,project)"
gcloud asset search-all-iam-policies --scope=organizations/ORG --query="policy:allUsers OR policy:allAuthenticatedUsers" --format="table(resource,policy.bindings.role)"
gcloud asset search-all-iam-policies --scope=organizations/ORG --query="policy.role.permissions:resourcemanager.projects.setIamPolicy" --format="table(resource,policy.bindings.members)"
```

## 5. Quotas and APIs

```bash
gcloud compute regions describe us-central1 --project=P --format="table(quotas.metric,quotas.usage,quotas.limit)"
gcloud services list --available --filter="name:aiplatform" --project=P
```

Enabling APIs (`gcloud services enable`) is a change: some APIs create service agents and default resources. Disabling APIs can break workloads (and security APIs are guard-blocked).

## Never

- Create or download service account keys; use impersonation / Workload Identity Federation.
- Grant `roles/owner`/`roles/editor` or bind `allUsers`/`allAuthenticatedUsers` (guard-blocked).
- Delete or move projects/folders, unlink billing (guard-blocked).
- Switch to a more privileged configuration because a read call returned 403; report the missing permission.
