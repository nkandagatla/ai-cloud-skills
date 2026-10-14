---
name: iac-security-review
description: Security and correctness review of infrastructure-as-code changes (Terraform/OpenTofu, CloudFormation, CDK, SAM, Bicep/ARM, Pulumi, Helm/Kubernetes manifests) for AWS, Azure and GCP. Use when reviewing an IaC diff or PR, before proposing an IaC change, or when asked "is this Terraform safe?".
---

# IaC Security Review

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Review the **diff** (or the files the user names) against the checklists below. Report findings ranked by severity with file:line, the risk in one sentence, and the exact fix. Do not rewrite unrelated code.

## Process

1. Determine scope: `git diff --merge-base origin/main -- '*.tf' '*.tfvars' '*.bicep' '*.json' '*.yaml' '*.yml' '*.ts' '*.py'` (only IaC paths).
2. Run available scanners (read-only, local). Use what is installed; do not install globally without asking.
   - Terraform: `terraform fmt -check -recursive`, `terraform validate`, `tflint --recursive`, `checkov -d . --compact --quiet`, `trivy config .` (tfsec is now part of Trivy).
   - CloudFormation/SAM: `cfn-lint template.yaml`, `cfn_nag_scan --input-path .`, `cfn-guard validate`.
   - CDK: `cdk synth` then scan `cdk.out/*.template.json` with checkov / cfn-lint; `cdk-nag` if the app includes it.
   - Bicep/ARM: `az bicep build --file main.bicep`, `bicep lint`, `Invoke-PSRule` with `PSRule.Rules.Azure`, `checkov -f main.json`.
   - Kubernetes/Helm: `helm template ... | kubeconform -strict -`, `kube-linter lint`, `checkov -d k8s/`, `trivy config k8s/`.
   - Secrets: `node .cloud-guard/bin/cloud-guard.mjs scan .`, `gitleaks detect --no-banner` if present.
3. Read the diff yourself. Scanners miss intent (for example, a wildcard IAM policy assembled from variables).
4. If a plan is available (`terraform show tfplan`), check replacements and destroys of stateful resources.
5. Report. Group: **Critical** (exploitable or data loss), **High**, **Medium**, **Low/Hygiene**. Suggest code for each fix.

## Universal checklist

**Identity**
- No `*` actions on `*` resources; no admin/owner/editor roles; no trust or binding to `*`, `allUsers`, `allAuthenticatedUsers`, or entire external accounts without conditions (`aws:SourceArn`, `aws:SourceAccount`, `sts:ExternalId`, `aws:PrincipalOrgID`).
- No long-lived credentials: `aws_iam_access_key`, `azuread_application_password`/`azuread_service_principal_password`, `google_service_account_key`.
- Workload identity / managed identity / IRSA / EKS Pod Identity used for workloads; OIDC for CI with `sub` claim conditions restricted to repo + branch/environment.
- Permission boundaries / scoped roles for anything that creates IAM.

**Network**
- No `0.0.0.0/0` / `::/0` / `*` ingress except 80/443 on public load balancers / front doors.
- Databases, caches, search, queues on private subnets / private endpoints / Private Service Connect.
- Egress controlled where required (NAT + firewall / Azure Firewall / Cloud NAT + firewall policies).
- Flow logs enabled on VPCs/VNets/subnets.

**Data**
- Encryption at rest everywhere; customer-managed keys where `CLOUD.md` requires them; key rotation enabled.
- TLS 1.2+ enforced in transit (`aws:SecureTransport`, `min_tls_version`, `ssl_enforcement`, `require_ssl`).
- Storage: S3 Block Public Access, Azure `allow_nested_items_to_be_public = false` and `shared_access_key_enabled = false`, GCS `public_access_prevention = "enforced"` and `uniform_bucket_level_access = true`.
- Versioning / soft delete / PITR / backups on stateful stores; deletion protection on databases; `prevent_destroy` lifecycle on critical resources.
- No sensitive values in outputs without `sensitive = true`; no secrets in `default` values, `tfvars`, user-data, container env, or tags.

**Logging and detection**
- Audit logging on (CloudTrail, Activity Log + diagnostic settings, Cloud Audit Logs Data Access where required).
- Resource logs to central workspace / bucket with retention per `CLOUD.md`.
- No resources disabling GuardDuty / Defender / SCC, or removing alerts.

**Resilience**
- Multi-AZ / zone-redundant where the tier requires it; autoscaling bounds sane (min > 0 for prod).
- Health checks and deletion protection on load balancers in prod.

**Supply chain and hygiene**
- Providers and modules pinned (`required_providers` with `~>` constraints, module `?ref=<tag or sha>`, registry version).
- No `local-exec` / `remote-exec` that curls and executes remote scripts.
- Required tags/labels present (`cloud-tagging-naming`).
- Names do not leak sensitive information.

## AWS specifics
- `aws_s3_bucket_public_access_block` all four true; `aws_s3_account_public_access_block` present at account level.
- `aws_security_group` rules: no admin ports from the internet; avoid inline + separate rule mixing.
- `aws_db_instance`/`aws_rds_cluster`: `publicly_accessible = false`, `storage_encrypted = true`, `deletion_protection = true`, `backup_retention_period >= 7`, `iam_database_authentication_enabled` where possible, `manage_master_user_password = true` (no `password` literal).
- `aws_instance`/launch templates: `metadata_options { http_tokens = "required" }` (IMDSv2), encrypted root volumes, no public IP unless needed.
- `aws_lambda_function_url` with `authorization_type = "NONE"` needs justification; `aws_lambda_permission` principals scoped with `source_arn`.
- `aws_eks_cluster`: private endpoint or `public_access_cidrs` restricted; secrets encryption with KMS; control-plane logging enabled.
- `aws_kms_key`: `enable_key_rotation = true`, key policy without `Principal: "*"` unless conditioned.
- `aws_cloudtrail`: multi-region, log file validation, KMS, not modified to stop logging.

## Azure specifics
- `azurerm_storage_account`: `min_tls_version = "TLS1_2"`, `allow_nested_items_to_be_public = false`, `shared_access_key_enabled = false`, `public_network_access_enabled = false` with private endpoints, infrastructure encryption where required.
- `azurerm_key_vault`: `purge_protection_enabled = true`, `soft_delete_retention_days >= 7`, `enable_rbac_authorization = true`, network ACLs default `Deny`.
- `azurerm_network_security_rule`: no `*` / `Internet` source to 22/3389/database ports.
- `azurerm_kubernetes_cluster`: `local_account_disabled = true`, Entra ID RBAC, `azure_policy_enabled = true`, API server authorized IP ranges or private cluster, workload identity, OIDC issuer.
- `azurerm_mssql_server` / PostgreSQL flexible: Entra-only auth where possible, `public_network_access_enabled = false`, no `0.0.0.0-255.255.255.255` firewall rule ("Allow all Azure services" is `0.0.0.0-0.0.0.0` and also needs justification).
- `azurerm_role_assignment`: no `Owner`/`User Access Administrator` from IaC except landing zone; scope as low as possible.
- Bicep: `@secure()` on secret params, no secrets in `outputs`, no `listKeys()` in outputs.

## GCP specifics
- `google_storage_bucket`: `public_access_prevention = "enforced"`, `uniform_bucket_level_access = true`, versioning / soft delete, CMEK where required.
- IAM: prefer `google_*_iam_member` (additive) over `google_*_iam_policy` / `_binding` (authoritative; can wipe grants). No basic roles. No `allUsers`.
- `google_compute_firewall`: no `0.0.0.0/0` to 22/3389; IAP range `35.235.240.0/20` for admin access.
- `google_compute_instance`: Shielded VM, OS Login (`enable-oslogin = TRUE`), no default service account with `cloud-platform` scope, no external IP unless needed.
- `google_sql_database_instance`: private IP, `ssl_mode = "ENCRYPTED_ONLY"` (or `TRUSTED_CLIENT_CERTIFICATE_REQUIRED`), `deletion_protection = true`, backups + PITR.
- `google_container_cluster`: private nodes, master authorized networks, Workload Identity, Shielded nodes, release channel, no legacy ABAC, network policy / Dataplane V2.
- `google_project_service` with `disable_on_destroy = true` can break projects; prefer `false`.

## Kubernetes manifests
- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, drop `ALL` capabilities, `seccompProfile: RuntimeDefault`.
- No `privileged`, `hostNetwork`, `hostPID`, `hostPath` (except vetted system agents).
- Resource requests/limits; liveness/readiness probes; PodDisruptionBudgets for prod.
- Images pinned by digest or immutable tag from an approved registry; no `latest`.
- Secrets via External Secrets / CSI driver, not plain `Secret` manifests committed to git.
- NetworkPolicies default-deny per namespace.

## Output format

```
## IaC review: <scope>
Scanners: checkov (n findings), tflint (n), trivy (n) | not installed: <list>

### Critical
1. modules/db/main.tf:42 — RDS instance is publicly accessible. Anyone on the internet can attempt to authenticate.
   Fix: `publicly_accessible = false` and place in private subnets via `db_subnet_group_name`.

### High
...
### Medium / Low
...
### Looks good
- <short list of controls correctly in place>
```
