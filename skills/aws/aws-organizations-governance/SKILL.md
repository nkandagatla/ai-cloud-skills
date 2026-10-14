---
name: aws-organizations-governance
description: AWS multi-account governance and security posture - Organizations, OUs, Service Control Policies, Resource Control Policies, Control Tower controls, delegated administrators, org-wide CloudTrail/Config/GuardDuty/Security Hub/Inspector/Macie, and declarative policies. Use when writing or reviewing SCPs/RCPs, designing guardrails, or auditing org security posture.
---

# AWS Organizations and Governance

Load `cloud-guardrails`. Organization-level changes affect every account. You **read, design and review**; changes to SCPs, RCPs, OUs and delegated admins ship only as IaC through the platform/security team's pipeline. The guard blocks direct `organizations` mutations.

## 1. Read the current state

```bash
aws organizations describe-organization --profile mgmt-readonly
aws organizations list-roots
aws organizations list-organizational-units-for-parent --parent-id r-xxxx
aws organizations list-policies --filter SERVICE_CONTROL_POLICY
aws organizations list-policies --filter RESOURCE_CONTROL_POLICY
aws organizations list-targets-for-policy --policy-id p-xxxx
aws organizations describe-policy --policy-id p-xxxx --query Policy.Content --output text | jq .
aws organizations list-delegated-administrators
aws controltower list-enabled-controls --target-identifier arn:aws:organizations::...:ou/o-xxx/ou-xxx
```

## 2. SCP design principles

- SCPs only **limit**; they never grant. Keep `FullAWSAccess` attached and add deny SCPs (deny-list strategy), unless the org deliberately uses allow-lists.
- Exempt a small set of platform roles via `aws:PrincipalArn` conditions (`arn:aws:iam::*:role/OrganizationAccountAccessRole`, `AWSControlTowerExecution`, the pipeline role, `BreakGlass`).
- Size limit 5,120 characters per SCP, 5 SCPs per target: consolidate.
- Test in a test OU first; watch CloudTrail for `AccessDenied` with "service control policy" for a week.

## 3. Baseline SCP set (starting point)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyLeavingOrgAndAccountChanges",
      "Effect": "Deny",
      "Action": ["organizations:LeaveOrganization", "account:CloseAccount", "account:PutAlternateContact", "account:DeleteAlternateContact"],
      "Resource": "*",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": ["arn:aws:iam::*:role/BreakGlass"] } }
    },
    {
      "Sid": "ProtectSecurityServices",
      "Effect": "Deny",
      "Action": [
        "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors",
        "guardduty:DeleteDetector", "guardduty:DisassociateFromMasterAccount", "guardduty:DisassociateFromAdministratorAccount", "guardduty:UpdateDetector",
        "securityhub:DisableSecurityHub", "securityhub:DisassociateFromAdministratorAccount",
        "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:DeleteDeliveryChannel",
        "access-analyzer:DeleteAnalyzer", "macie2:DisableMacie", "inspector2:Disable",
        "ec2:DeleteFlowLogs", "logs:DeleteLogGroup"
      ],
      "Resource": "*",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": ["arn:aws:iam::*:role/AWSControlTowerExecution", "arn:aws:iam::*:role/SecurityAutomation"] } }
    },
    {
      "Sid": "DenyRootUser",
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": { "StringLike": { "aws:PrincipalArn": "arn:aws:iam::*:root" } }
    },
    {
      "Sid": "DenyIAMUserKeys",
      "Effect": "Deny",
      "Action": ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"],
      "Resource": "*",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": ["arn:aws:iam::*:role/BreakGlass"] } }
    },
    {
      "Sid": "RegionGuard",
      "Effect": "Deny",
      "NotAction": [
        "a4b:*", "access-analyzer:*", "account:*", "acm:*", "aws-portal:*", "budgets:*", "ce:*", "cloudfront:*", "config:*",
        "cur:*", "globalaccelerator:*", "health:*", "iam:*", "kms:*", "organizations:*", "pricing:*", "route53:*",
        "route53domains:*", "s3:GetAccountPublic*", "s3:ListAllMyBuckets", "s3:PutAccountPublic*", "shield:*",
        "sso:*", "sts:*", "support:*", "trustedadvisor:*", "waf:*", "wafv2:*", "wellarchitected:*"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": { "aws:RequestedRegion": ["us-east-1", "us-west-2"] },
        "ArnNotLike": { "aws:PrincipalArn": ["arn:aws:iam::*:role/AWSControlTowerExecution"] }
      }
    }
  ]
}
```

Notes: the root-deny statement blocks root in **member** accounts (SCPs never affect the management account). Verify the `NotAction` global-service list against current AWS documentation and Control Tower's region-deny control before use; it changes over time. Split into multiple SCPs if you hit the size limit.

Prod OU additions: deny `ec2:DisableEbsEncryptionByDefault` and `s3:PutAccountPublicAccessBlock` (keeps account-level settings immutable). Some risky settings, such as a publicly accessible RDS instance, have no SCP condition key; enforce those with AWS Config rules, Control Tower proactive controls and IaC checks instead.

## 4. Resource Control Policies (RCPs)

RCPs restrict what can be done **to resources** in member accounts regardless of the caller (S3, STS, KMS, SQS, Secrets Manager and more). Use them to build a **data perimeter**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EnforceOrgIdentities",
    "Effect": "Deny",
    "Principal": "*",
    "Action": ["s3:*", "sqs:*", "kms:*", "secretsmanager:*", "sts:AssumeRole"],
    "Resource": "*",
    "Condition": {
      "StringNotEqualsIfExists": { "aws:PrincipalOrgID": "o-xxxxxxxxxx" },
      "BoolIfExists": { "aws:PrincipalIsAWSService": "false" }
    }
  }]
}
```

Plus a `aws:SecureTransport = false` deny for TLS. Inventory legitimate third-party access first (vendors, CloudFront OAC uses service principal), or this will break things.

## 5. Declarative policies

Declarative policies (EC2) enforce settings such as blocking public AMI/snapshot sharing, IMDSv2 defaults and serial console access across the org and survive new APIs. Prefer them over per-account scripts where available.

## 6. Org-wide security services (delegated admin in Security account)

| Service | Org setup | Posture check |
| --- | --- | --- |
| CloudTrail | Organization trail → log-archive S3 (Object Lock) + CloudTrail Lake optional | `describe-trails` from mgmt |
| Config | Recorder in every account/region (Control Tower), aggregator in Security | `describe-configuration-aggregators` |
| GuardDuty | Auto-enable for new accounts, protection plans (S3, EKS, Runtime, Malware, RDS, Lambda) | `aws guardduty describe-organization-configuration --detector-id` |
| Security Hub | Central configuration policies, FSBP + CIS standards, cross-region aggregation | `aws securityhub describe-organization-configuration` |
| Inspector | Auto-enable EC2/ECR/Lambda scanning | `aws inspector2 describe-organization-configuration` |
| Macie | Automated sensitive data discovery on S3 | `aws macie2 describe-organization-configuration` |
| Access Analyzer | Org analyzer (external) + unused access analyzer | `list-analyzers` |
| Detective | Optional investigation graph | |

## 7. Posture review output

```
Org: o-xxxx   Accounts: n   OUs: <tree summary>
Guardrails present: <SCP list with targets>   Gaps: <e.g. no region guard on Workloads OU>
Security services coverage: GuardDuty 41/43 accounts (missing: ...), Security Hub ...
Top findings (Security Hub critical/high, by control)
Recommendations (IaC PRs): ...
```

## Never

- Detach/delete SCPs or RCPs, disable policy types, move accounts between OUs, or deregister delegated admins from an agent (guard-blocked).
- Test new SCPs directly on Prod OU.
- Exempt broad principals (`arn:aws:iam::*:role/*`) to make a policy "work".
