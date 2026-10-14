---
name: secrets-and-identity
description: Cross-cloud patterns for workload identity and secrets - IAM roles, IRSA/EKS Pod Identity, Azure managed identity and workload identity, GCP service accounts and Workload Identity Federation, secret managers, rotation, and how to remove long-lived keys. Use when an app or pipeline needs credentials, when you see access keys / client secrets / key JSON, or when designing secret handling.
---

# Secrets and Identity

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

The goal: **no long-lived credentials anywhere**, every workload has its own narrowly-scoped identity, and secret values never pass through an agent, a repo, or a chat.

## Decision table: how should X authenticate?

| Caller | AWS | Azure | GCP |
| --- | --- | --- | --- |
| VM | Instance profile (IAM role), IMDSv2 | System/user-assigned managed identity | Attached service account (not default SA) |
| Kubernetes pod | EKS Pod Identity (or IRSA) | AKS Workload Identity (federated credential on UAMI) | GKE Workload Identity Federation for GKE |
| Serverless | Lambda execution role / ECS task role | Function/App Service/Container Apps managed identity | Cloud Run / Functions service account |
| CI/CD (GitHub, GitLab, Azure DevOps) | OIDC → `AssumeRoleWithWebIdentity` | Federated credential (OIDC) on app/UAMI | Workload Identity Federation pool + provider |
| Another cloud | IAM Roles Anywhere, or OIDC federation | Workload identity federation | WIF with AWS/Azure provider |
| Human | IAM Identity Center (SSO) + MFA | Entra ID + MFA + PIM | Cloud Identity / Workspace + 2SV |
| On-prem server | IAM Roles Anywhere (X.509) | Azure Arc managed identity | WIF with X.509 / OIDC |

Long-lived keys are a last resort with an exception ticket, rotation ≤ 90 days, and a secret-manager home.

## Secret managers

| | AWS | Azure | GCP |
| --- | --- | --- | --- |
| Store | Secrets Manager (rotation) / SSM Parameter Store `SecureString` | Key Vault secrets (RBAC mode) | Secret Manager |
| Encryption | KMS CMK | Key Vault / Managed HSM | Cloud KMS CMEK optional |
| Runtime fetch | SDK with role; Lambda extension; ECS `secrets`; Secrets Store CSI | Key Vault references (App Service/Functions/Container Apps); CSI driver | Secret Manager SDK; Cloud Run `--set-secrets`; CSI / Secret Manager add-on for GKE |
| K8s sync | External Secrets Operator / Secrets Store CSI Driver (works on all three) | | |

Rules for agents:

- Create the **secret container** in IaC; the **value** is set by a human, by the service itself (e.g. RDS `manage_master_user_password`), or by a generator (`random_password` + ephemeral/write-only where supported).
- To check a secret, read metadata only: `aws secretsmanager describe-secret`, `az keyvault secret list --vault-name X --query "[].{name:name,enabled:attributes.enabled}"` (not `secret show`, which returns the value), `gcloud secrets describe`, `gcloud secrets versions list`.
- Grant read on **one secret**, not on the whole vault/account/project.

## Least privilege for workload identities

- One identity per workload per environment. Never share a role/identity across apps.
- Start from "deny everything", add the specific actions observed or documented. Use IAM Access Analyzer policy generation (AWS), Azure built-in data-plane roles (e.g. `Storage Blob Data Reader` on one container), GCP IAM Recommender.
- Add conditions: resource ARNs / scopes, `aws:SourceVpce`, tags (ABAC), Azure conditions on blob paths, GCP IAM Conditions (`resource.name.startsWith(...)`, time-bound).
- Review unused permissions quarterly (Access Analyzer unused access, Entra access reviews, GCP Recommender / Policy Analyzer).

## Removing long-lived credentials (migration playbook)

1. **Inventory** (read-only):
   - AWS: `aws iam list-users --query "Users[].UserName"` then `aws iam list-access-keys --user-name X`; credential report (`aws iam generate-credential-report`, then `get-credential-report` decoded locally, never pasted).
   - Azure: `az ad app list --all --query "[?passwordCredentials!=null].{app:displayName,id:appId}"`; `az ad app credential list --id <appId> --query "[].{hint:hint,end:endDateTime}"` (no secret values are returned).
   - GCP: `gcloud iam service-accounts keys list --iam-account SA --managed-by=user`; org-wide via Policy Analyzer / Cloud Asset Inventory.
2. **Find usage**: CloudTrail `userIdentity.accessKeyId`, Entra sign-in logs (service principal sign-ins), GCP audit logs `authenticationInfo.serviceAccountKeyName`.
3. **Replace** with the identity mechanism from the table above; deploy and verify.
4. **Disable** the old key (not delete) and watch for failures for an agreed period.
5. **Delete** the key and add a preventive control (SCP / policy / org policy) so it cannot come back.

Steps 3-5 are changes: follow `cloud-change-plan`.

## Rotation

- AWS Secrets Manager managed rotation for RDS/Redshift/DocumentDB; Lambda rotation for others.
- Azure Key Vault rotation policies (keys), Event Grid `SecretNearExpiry` + automation (secrets).
- GCP Secret Manager rotation schedule → Pub/Sub topic → Cloud Run job that rotates.
- Apps must re-read secrets (short cache TTL) so rotation does not need redeploys.

## Leaked secret response

Go to `cloud-incident-response` → "Credential exposure". In short: revoke/rotate first, investigate second, never re-post the secret.
