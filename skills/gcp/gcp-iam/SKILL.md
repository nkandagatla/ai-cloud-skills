---
name: gcp-iam
description: Google Cloud IAM design, review and troubleshooting - predefined vs custom roles, additive bindings vs authoritative policies, IAM Conditions, service accounts and impersonation, Workload Identity Federation, IAM deny policies, Principal Access Boundary, Recommender/Policy Analyzer/Policy Troubleshooter, and privilege-escalation risks. Use for any IAM binding, service account, role or 403 PERMISSION_DENIED on GCP.
---

# Google Cloud IAM

Load `cloud-guardrails` and `secrets-and-identity`. IAM changes are IaC + review. The guard blocks basic roles, public principals, SA key creation, privilege-escalating roles and `set-iam-policy`.

## 1. Model

- **Allow policies** on resources (org → folder → project → resource), inherited downward, additive.
- **Deny policies** (IAM v2) attached to org/folder/project: override allows for listed permissions and principals (with exceptions).
- **Principal Access Boundary** policies limit which resources a principal can access at all.
- **Org policies** are not IAM but constrain configuration (`gcp-org-policy-security`).
- **VPC Service Controls** add a perimeter on API access.

## 2. Bind safely in Terraform

| Resource type | Behaviour | Use |
| --- | --- | --- |
| `google_*_iam_member` | Additive, one member + role | **Default choice** |
| `google_*_iam_binding` | Authoritative for **one role** (removes other members of that role) | Only when one module owns that role fully |
| `google_*_iam_policy` | Authoritative for the **whole policy** (can wipe everything, including service agents) | Avoid; never on projects/folders/org |

```hcl
resource "google_project_iam_member" "orders_api_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.orders_api.email}"
  condition {
    title      = "only-orders-topics"
    expression = "resource.name.startsWith(\"projects/${var.project_id}/topics/orders-\")"
  }
}
```

Prefer granting on the **resource** (topic, bucket, secret) instead of the project:

```hcl
resource "google_secret_manager_secret_iam_member" "db" {
  secret_id = google_secret_manager_secret.db.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.orders_api.email}"
}
```

## 3. Role choice

- Predefined roles specific to the service (`roles/storage.objectViewer`, `roles/run.invoker`, `roles/cloudsql.client`) over broad ones; **never** basic roles (`owner`, `editor`, `viewer` is acceptable only for auditors).
- Custom roles for tight sets of permissions; manage at org level for reuse; track `stage` (GA/BETA).
- Humans: Google Groups as members, never individual users; time-bound elevated access with **Privileged Access Manager (PAM)** entitlements or IAM Conditions with `request.time`.
- High-risk roles to watch: `roles/iam.serviceAccountUser` (actAs), `roles/iam.serviceAccountTokenCreator`, `roles/iam.serviceAccountKeyAdmin`, `roles/resourcemanager.projectIamAdmin`, `roles/iam.securityAdmin`, `roles/iam.roleAdmin`, `roles/cloudfunctions.developer` + actAs, `roles/run.admin` + actAs, `roles/compute.instanceAdmin.v1` + actAs (deploy code as a privileged SA), `roles/deploymentmanager.editor`, `roles/cloudbuild.builds.editor` (runs as Cloud Build SA).

## 4. Service accounts

- One SA per workload per environment; descriptive `account_id` and `description`.
- Disable the default compute and App Engine SAs' automatic Editor grant (org policy) and do not attach default SAs to workloads.
- Users deploy workloads "as" an SA only with `roles/iam.serviceAccountUser` **on that SA**, not on the project.
- Keys: forbidden (org policy `iam.managed.disableServiceAccountKeyCreation` / legacy `iam.disableServiceAccountKeyCreation`). Use attached SAs, Workload Identity Federation (CI, other clouds, on-prem), or impersonation for humans.
- WIF providers must have an **attribute condition** restricting repository/issuer (guard-blocked without one).

## 5. Read-only audits

```bash
gcloud projects get-iam-policy P --format=json > /tmp/p-iam.json   # keep local, do not paste wholesale; summarise
gcloud projects get-iam-policy P --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members~^user:"
gcloud iam service-accounts list --project=P --format="table(email,disabled)"
gcloud iam service-accounts get-iam-policy SA_EMAIL
gcloud recommender recommendations list --project=P --location=global --recommender=google.iam.policy.Recommender --format="table(description,primaryImpact.securityProjection)"
gcloud policy-intelligence query-activity --activity-type=serviceAccountLastAuthentication --project=P
gcloud iam policies list --attachment-point="cloudresourcemanager.googleapis.com%2Fprojects%2FP" --kind=denypolicies
```

Policy Analyzer for "who can do X on Y": `gcloud asset analyze-iam-policy --organization=ORG --full-resource-name=//storage.googleapis.com/projects/_/buckets/B --permissions=storage.objects.get`.

## 6. Troubleshooting `PERMISSION_DENIED`

1. Identify the principal actually calling (impersonated SA? attached SA? ADC user?). `gcloud config list`, and the error's principal.
2. Required permission (error names it) → which predefined roles contain it: `gcloud iam roles list --filter="includedPermissions:storage.objects.get"` (or docs).
3. `gcloud policy-troubleshoot iam //storage.googleapis.com/projects/_/buckets/B --permission=storage.objects.get --principal-email=SA` (checks allow + deny policies).
4. Deny policies, Principal Access Boundary, IAM Conditions (time/resource name), VPC Service Controls (error mentions `VPC_SERVICE_CONTROLS` / `vpcServiceControlsUniqueIdentifier`), org policy constraints (`FAILED_PRECONDITION` with constraint name).
5. API not enabled in the project (different error, `SERVICE_DISABLED`), or quota project for ADC user credentials.
6. Propagation: typically seconds to minutes; group membership changes can take longer.
7. Propose the narrowest fix as IaC.

## Never

- `set-iam-policy` / `google_project_iam_policy` (whole-policy overwrite), basic roles, `allUsers`/`allAuthenticatedUsers` (guard-blocked).
- Create SA keys or WIF providers without attribute conditions (guard-blocked).
- Grant `serviceAccountUser`/`TokenCreator` at project level, or to `allAuthenticatedUsers`.
- Delete or disable service accounts used by pipelines/landing zone (guard-blocked for common names).
