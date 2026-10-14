---
name: aws-kms-secrets
description: AWS encryption keys and secrets - KMS key design, key policies and grants, rotation, multi-region keys, Secrets Manager (rotation, replication, resource policies), SSM Parameter Store SecureString, ACM certificates, and troubleshooting KMS AccessDenied. Use when creating or reviewing keys, key policies, secrets, rotation, or certificate issues.
---

# AWS KMS and Secrets

Load `cloud-guardrails` and `secrets-and-identity`. Agents design and review keys and secret containers; agents never read secret values, decrypt data, or delete/disable keys (guard-blocked).

## 1. KMS key design

- One CMK per **data domain and environment** (e.g. `alias/orders-prod`), not one per resource and not one for everything.
- Symmetric `SYMMETRIC_DEFAULT` for encryption; asymmetric only for signing (e.g. cosign) or specific needs; HMAC keys for MACs.
- `enable_key_rotation = true` (rotation period configurable 90-2560 days; default yearly).
- Multi-region keys only when data must be decrypted in another region (DR, global tables); they increase blast radius.
- `deletion_window_in_days = 30`; deletion is a human, ticketed, irreversible decision.

## 2. Key policy pattern (separation of duties)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AccountRootForIAMDelegation", "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:root" }, "Action": "kms:*", "Resource": "*" },
    { "Sid": "KeyAdmins", "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:role/platform-kms-admin" },
      "Action": ["kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Get*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"],
      "Resource": "*" },
    { "Sid": "UseViaServicesOnly", "Effect": "Allow",
      "Principal": { "AWS": ["arn:aws:iam::111122223333:role/orders-api-task"] },
      "Action": ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": ["s3.us-east-1.amazonaws.com", "secretsmanager.us-east-1.amazonaws.com"] } } }
  ]
}
```

The root statement delegates to IAM (so IAM policies can grant use) and prevents the key from becoming unmanageable; keep it unless your org has a deliberate alternative. Admins cannot use the key for crypto; users cannot administer it. Cross-account use: add the other account's role in the key policy **and** an IAM policy in that account. Prefer `kms:ViaService` and encryption-context conditions.

Grants: used by services (EBS, RDS); review with `aws kms list-grants --key-id K`; retire unused grants via IaC owners.

## 3. Secrets Manager

- Secret per credential per environment, path-like names (`prod/orders/db`), CMK encryption for sensitive classes.
- Rotation: managed rotation for RDS/Aurora/Redshift/DocumentDB (`manage_master_user_password` or rotation Lambda templates); rotation schedule ≤ 90 days (30 for high sensitivity).
- Resource policy: deny access outside the org / specific roles; `BlockPublicPolicy` validation (`aws secretsmanager validate-resource-policy`).
- Replica secrets for DR regions.
- Apps read through the SDK / Lambda extension / ECS `secrets` with caching.

Parameter Store: `SecureString` with a CMK for config secrets when rotation is not needed; hierarchy `/env/app/key`; Advanced tier for policies (expiration notifications).

## 4. Read-only inspection (never values)

```bash
aws kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/aws/')==\`false\`].[AliasName,TargetKeyId]" --output table
aws kms describe-key --key-id alias/orders-prod --query "KeyMetadata.{state:KeyState,spec:KeySpec,usage:KeyUsage,multi:MultiRegion,manager:KeyManager,origin:Origin}"
aws kms get-key-rotation-status --key-id alias/orders-prod
aws kms get-key-policy --key-id alias/orders-prod --policy-name default --output text | jq .
aws secretsmanager list-secrets --query "SecretList[].{n:Name,rot:RotationEnabled,last:LastRotatedDate,next:NextRotationDate,kms:KmsKeyId}" --output table
aws secretsmanager describe-secret --secret-id prod/orders/db
aws ssm describe-parameters --parameter-filters Key=Path,Option=Recursive,Values=/prod/orders
aws acm list-certificates --query "CertificateSummaryList[].{d:DomainName,status:Status,exp:NotAfter,inUse:InUse,renew:RenewalEligibility}"
```

## 5. Troubleshooting KMS AccessDenied

1. Which principal and which action (`Decrypt`, `GenerateDataKey`, `CreateGrant` for EBS/RDS)? Check CloudTrail `kms.amazonaws.com` events with `errorCode`.
2. Key policy allows the principal (directly or via root delegation + IAM policy)?
3. Conditions: `kms:ViaService`, encryption context mismatch, `kms:CallerAccount`.
4. Key state: `Disabled` / `PendingDeletion` (critical: if pending deletion, alert a human immediately; it can be cancelled).
5. SCP/RCP denies; VPC endpoint policy for `kms`.
6. Region: KMS keys are regional (multi-region replicas are separate keys).

## 6. Certificates (ACM)

DNS validation records in Route 53 (auto-renewal), certificates for CloudFront in `us-east-1`, alarm on `DaysToExpiry` for imported certificates (no auto-renew). Private CA for internal mTLS (cost: significant monthly fee).

## Never

- `schedule-key-deletion`, `disable-key`, `put-key-policy`, delete imported key material (guard-blocked).
- `get-secret-value`, `get-parameter --with-decryption`, `kms decrypt` from an agent (guard-blocked).
- Key policies with `Principal: "*"` without org/service conditions.
- Share one CMK across environments.
