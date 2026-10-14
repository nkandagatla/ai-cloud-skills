---
name: aws-iam
description: Design, write, review and troubleshoot AWS IAM - least-privilege policies, roles and trust policies, permission boundaries, ABAC with tags, resource policies, cross-account access, IAM Identity Center permission sets, Access Analyzer, and AccessDenied debugging. Use for any IAM policy, role, trust relationship or permission error.
---

# AWS IAM

Load `cloud-guardrails`. IAM changes are security-relevant changes: always IaC, always reviewed, never `*:*`, never admin grants from an agent.

## 1. Mental model (evaluation order)

Explicit **deny** anywhere wins → SCPs/RCPs (org) must allow → resource-based policy → identity policy → permission boundary → session policy. A request is allowed only if every applicable layer allows it and none denies it. Cross-account: both the caller's identity policy and the resource/trust policy must allow.

## 2. Writing least-privilege policies

Rules:

1. Specific actions (no `s3:*`, no `*`), specific resources (ARNs with names/prefixes), conditions where possible.
2. Separate statements per resource type; use `Sid`s that explain intent.
3. Prefer AWS managed **job-function** policies only for humans in nonprod; workloads get customer-managed policies.
4. Use condition keys: `aws:SourceVpce`, `aws:SourceArn`, `aws:SourceAccount`, `aws:PrincipalOrgID`, `aws:ResourceTag/*`, `aws:RequestedRegion`, `aws:SecureTransport`, `aws:MultiFactorAuthPresent` (humans).
5. Generate from activity: IAM Access Analyzer policy generation from CloudTrail, then trim.

Example: Lambda that reads one prefix and writes to one DynamoDB table.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadInputPrefix", "Effect": "Allow", "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::acme-orders-prod/incoming/*" },
    { "Sid": "ListInputPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-orders-prod",
      "Condition": { "StringLike": { "s3:prefix": ["incoming/*"] } } },
    { "Sid": "WriteOrders", "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
      "Resource": "arn:aws:dynamodb:us-east-1:111122223333:table/orders" },
    { "Sid": "DecryptWithAppKey", "Effect": "Allow", "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:us-east-1:111122223333:key/1234abcd-...",
      "Condition": { "StringEquals": { "kms:ViaService": ["s3.us-east-1.amazonaws.com", "dynamodb.us-east-1.amazonaws.com"] } } }
  ]
}
```

Validate before proposing:

```bash
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://policy.json
aws accessanalyzer check-no-new-access --existing-policy-document file://old.json --new-policy-document file://new.json --policy-type IDENTITY_POLICY
aws accessanalyzer check-access-not-granted --policy-document file://policy.json --access '[{"actions":["iam:PassRole","s3:DeleteBucket"]}]' --policy-type IDENTITY_POLICY
```

## 3. Trust policies

- Service roles: `"Principal": {"Service": "lambda.amazonaws.com"}` plus `aws:SourceArn`/`aws:SourceAccount` conditions to prevent confused deputy.
- Cross-account: specific role ARN (not account root) when possible, `sts:ExternalId` for third parties, `aws:PrincipalOrgID` for in-org.
- OIDC (CI, EKS IRSA): exact `aud` and `sub` (`cicd-oidc`). EKS Pod Identity uses `pods.eks.amazonaws.com` with `sts:AssumeRole` + `sts:TagSession`.
- Never `"Principal": "*"` or `{"AWS": "*"}` without restrictive conditions (guard-blocked on the CLI).

## 4. Privilege escalation paths to watch in reviews

`iam:PassRole` (scope with resource ARNs and `iam:PassedToService`), `iam:CreatePolicyVersion`, `iam:SetDefaultPolicyVersion`, `iam:AttachRolePolicy`/`PutRolePolicy` on own role, `iam:UpdateAssumeRolePolicy`, `iam:CreateAccessKey`, `iam:CreateLoginProfile`/`UpdateLoginProfile`, `lambda:UpdateFunctionCode` on a privileged function, `ec2:RunInstances` + PassRole of an admin profile, `ssm:SendCommand` to privileged instances, `sts:AssumeRole` on `*`, `glue:CreateDevEndpoint`, `cloudformation:CreateStack` with PassRole. Any role that can create or modify IAM needs a **permission boundary**.

Permission boundary pattern for delegated IAM creation:

```json
{ "Sid": "CreateRolesOnlyWithBoundary", "Effect": "Allow",
  "Action": ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:PutRolePolicy"],
  "Resource": "arn:aws:iam::111122223333:role/app/*",
  "Condition": { "StringEquals": { "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/app-boundary" } } }
```

## 5. ABAC (attribute-based)

Tag principals and resources with `project`/`team`, then allow when `aws:ResourceTag/project` equals `${aws:PrincipalTag/project}`. Also deny tag changes on the governing keys (`aws:TagKeys`) so users cannot re-tag themselves into access.

## 6. Humans: IAM Identity Center

Permission sets per job function and environment (`ReadOnly`, `Developer-NonProd`, `Deploy-Prod` time-bound via an access-request process, `BreakGlass` with alarms). Session duration ≤ 8h, prod ≤ 1-4h. Assign to **groups** from the IdP, not to users.

## 7. Troubleshooting AccessDenied (read-only)

1. Read the full error: it often names the policy type that denied (`explicit deny in a service control policy`, `no identity-based policy allows`, `permissions boundary`, `resource-based policy`).
2. Confirm the principal: `aws sts get-caller-identity` (assumed role + session name).
3. Decode encoded messages: `aws sts decode-authorization-message --encoded-message ...` (contains policy context; do not paste broadly).
4. Simulate: `aws iam simulate-principal-policy --policy-source-arn ROLE_ARN --action-names s3:GetObject --resource-arns arn:aws:s3:::bucket/key`.
5. Check SCPs/RCPs on the account's OU, resource policies (bucket policy, KMS key policy: KMS denies are the most common hidden cause), VPC endpoint policies, and session policies.
6. Find the CloudTrail event (`errorCode = AccessDenied`) for exact action/resource.
7. Propose the minimal fix as an IaC diff. Never "fix" with a wildcard.

## 8. Hygiene audits (read-only)

```bash
aws accessanalyzer list-findings-v2 --analyzer-arn ARN --filter '{"status":{"eq":["ACTIVE"]}}'     # external + unused access
aws iam list-roles --query "Roles[?RoleLastUsed.LastUsedDate==null].RoleName"   # needs get-role per role for accuracy
aws iam list-policies --scope Local --only-attached --query "Policies[].Arn"
aws iam list-entities-for-policy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

Report: admin attachments, wildcard policies, unused roles (90+ days), roles trusting external accounts, users with access keys older than 90 days.

## Never (guard-enforced where possible)

- Attach `AdministratorAccess`/`IAMFullAccess`/`PowerUserAccess`, write `Action:*` + `Resource:*`, or open trust to `*`.
- Create access keys, login profiles, or deactivate MFA.
- Remove permission boundaries or SCPs to unblock a deploy.
