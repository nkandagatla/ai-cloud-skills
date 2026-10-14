---
name: aws-foundations
description: AWS basics done safely - CLI v2 profiles and IAM Identity Center (SSO) login, account/region targeting, multi-account landing zone layout (Control Tower, OUs), account baseline (root lockdown, CloudTrail, Config, GuardDuty, Security Hub, budgets) and service quotas. Use when starting AWS work, setting up or auditing an account, or when the target account/region is unclear.
---

# AWS Foundations

Load `cloud-guardrails` first. This skill establishes **who you are and where you are** before any other AWS skill runs.

## 1. Authentication (humans and agents on laptops)

Use IAM Identity Center (SSO). No IAM users, no access keys in `~/.aws/credentials`.

```ini
# ~/.aws/config  (the user creates this; never read credential files)
[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile acme-dev-readonly]
sso_session = acme
sso_account_id = 222233334444
sso_role_name = ReadOnlyAccess
region = us-east-1

[profile acme-dev-deploy]
sso_session = acme
sso_account_id = 222233334444
sso_role_name = PowerUserDeploy
region = us-east-1
```

```bash
aws sso login --sso-session acme
aws configure list-profiles
```

Agents default to the **read-only** profile and switch to a write profile only for an approved change, then switch back.

## 2. Always confirm target

```bash
aws sts get-caller-identity --profile acme-dev-readonly
aws configure list --profile acme-dev-readonly          # region + credential source (no secrets shown)
aws account list-regions --region-opt-status-contains ENABLED ENABLED_BY_DEFAULT --query "Regions[].RegionName" --output text
```

Map the account id to its tier via `CLOUD.md`. Always pass `--profile` and `--region` explicitly in commands you show the user.

Useful output habits: `--output table|json|text`, `--query` (JMESPath) to trim, `--no-cli-pager`, `--max-items` for big lists.

## 3. Multi-account landing zone (reference)

```
Root (management account: billing + Organizations only, no workloads)
├── Security OU        → log-archive, security-tooling (delegated admin for GuardDuty, Security Hub, Config, Inspector, Macie)
├── Infrastructure OU  → network (Transit Gateway, egress, DNS), shared-services
├── Workloads OU
│   ├── Prod OU        → app-a-prod, app-b-prod
│   └── NonProd OU     → app-a-dev, app-a-stage
├── Sandbox OU         → per-developer accounts, budget-capped, auto-nuked
└── Suspended OU       → closed/quarantined accounts (deny-all SCP)
```

Built with Control Tower (+ Account Factory / AFT) or Landing Zone Accelerator. Guardrails: `aws-organizations-governance`.

## 4. Account baseline checklist (audit read-only)

| Control | Check |
| --- | --- |
| Root user: MFA (hardware/passkey), no access keys, not used | `aws iam get-account-summary --query "SummaryMap.{mfa:AccountMFAEnabled,keys:AccountAccessKeysPresent}"`; Organizations root access management (centralised root) where available |
| No IAM users for humans | `aws iam list-users --query "Users[].{u:UserName,last:PasswordLastUsed}"` |
| Password policy (if any IAM users remain) | `aws iam get-account-password-policy` |
| Org CloudTrail, multi-region, validated, KMS | `aws cloudtrail describe-trails` + `get-trail-status --name X` |
| AWS Config recorder on (all regions in use) | `aws configservice describe-configuration-recorder-status` |
| GuardDuty enabled (all regions in use) | `aws guardduty list-detectors` |
| Security Hub + standards | `aws securityhub get-enabled-standards` |
| IAM Access Analyzer (org + unused access) | `aws accessanalyzer list-analyzers` |
| S3 account-level Block Public Access | `aws s3control get-public-access-block --account-id ID` |
| EBS default encryption, snapshot & AMI block public access | `aws ec2 get-ebs-encryption-by-default`; `aws ec2 get-snapshot-block-public-access-state`; `aws ec2 get-image-block-public-access-state` |
| IMDSv2 default for new instances | `aws ec2 get-instance-metadata-defaults` |
| Budgets + anomaly detection | `aws budgets describe-budgets --account-id ID`; `aws ce get-anomaly-monitors` |
| Alternate contacts (security, ops, billing) | `aws account get-alternate-contact --alternate-contact-type SECURITY` |
| Unused regions disabled or denied by SCP | see `aws-organizations-governance` |

Report gaps; fixes go through IaC (Control Tower controls, StackSets, Terraform) via `cloud-change-plan`. Account-level settings in prod accounts are changed only by the platform team.

## 5. Service quotas

```bash
aws service-quotas list-service-quotas --service-code ec2 --query "Quotas[?Adjustable].{n:QuotaName,v:Value}" --output table
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A   # Running On-Demand Standard instances (vCPU)
```

Quota increase requests are changes (cost implications): ask first.

## 6. Region discipline

Use only regions in `CLOUD.md`. Global services (IAM, Organizations, CloudFront, Route 53, WAF for CloudFront) live in `us-east-1` for API calls. Check the region before concluding "the resource does not exist".

## Never

- Use or create root access keys; log in as root for routine work.
- Create IAM users / access keys for humans or CI (`secrets-and-identity`, `cicd-oidc`).
- Read `~/.aws/credentials` or the SSO cache, or print `aws configure export-credentials` output.
- Switch to an admin profile because a read-only call failed with AccessDenied; report the missing permission instead.
