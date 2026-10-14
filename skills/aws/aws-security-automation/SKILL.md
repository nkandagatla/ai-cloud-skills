---
name: aws-security-automation
description: Build guarded security auto-remediation on AWS - EventBridge rules on GuardDuty/Security Hub/Config/CloudTrail events, Lambda and SSM Automation runbooks, AWS Config remediation, Security Hub automation rules, notification pipelines, with dry-run, scoping, kill switches and audit trails. Use when automating detection-to-response, writing remediation Lambdas/runbooks, or reviewing existing auto-remediation.
---

# AWS Security Automation (auto-remediation)

Load `cloud-guardrails`. Auto-remediation is code that changes production without a human in the loop at run time. It therefore needs **more** guardrails than a normal change: narrow triggers, reversible actions, dry-run mode, a kill switch, full audit and staged rollout.

## 1. Decide what to automate

| Category | Examples | Automate? |
| --- | --- | --- |
| Reversible config fix, low blast radius | Re-enable S3 BPA on a bucket, enable EBS default encryption, enable VPC flow logs, add missing tags, enable S3 versioning | Yes, auto |
| Containment of clear-cut threat | Revoke a security group rule opening 22/3389 to `0.0.0.0/0`; deactivate an access key found on a public repo (AWS Health `AWS_RISK_CREDENTIALS_EXPOSED` event) | Yes, auto with notification |
| Containment with business impact | Isolate an EC2 instance (GuardDuty crypto-mining finding), disable a user, block an IP in WAF | Semi-auto: page a human, one-click approve (Slack/ChatOps or SSM approval step) |
| Destructive or ambiguous | Delete resources, terminate instances, delete IAM entities | No. Notify only |

## 2. Reference architecture

```
GuardDuty / Security Hub / Config / CloudTrail (via EventBridge default bus, in each account+region)
   → EventBridge rule (precise pattern) → cross-account event bus in Security account
   → Step Functions state machine (orchestration, approvals, retries)
        → Lambda / SSM Automation runbook (assumes a narrowly-scoped remediation role in the target account)
   → Security Hub finding updated (Workflow.Status = RESOLVED/NOTIFIED, Note = action taken)
   → SNS / Chatbot (Slack/Teams) notification + immutable audit log (S3 Object Lock / CloudTrail)
```

Alternatively: **AWS Config remediation** (SSM Automation documents like `AWS-DisableIncomingSSHOnPort22`, `AWSConfigRemediation-ConfigureS3BucketPublicAccessBlock`) with `Automatic = true` and `MaximumAutomaticAttempts`; and **Security Hub automation rules** for finding triage (suppress known-good, raise severity) without changing resources.

## 3. Guardrails for every remediation

1. **Precise trigger**: match on finding type, severity, resource type, account list / OU and region. No catch-all patterns.
   ```json
   {
     "source": ["aws.securityhub"],
     "detail-type": ["Security Hub Findings - Imported"],
     "detail": { "findings": {
       "Compliance": { "Status": ["FAILED"] },
       "ProductFields": { "ControlId": ["S3.8"] },
       "Workflow": { "Status": ["NEW"] },
       "RecordState": ["ACTIVE"]
     } }
   }
   ```
2. **Scope by tags/exceptions**: skip resources tagged `security-exception=<ticket>` (validated against an allow-list in SSM Parameter Store, not free text).
3. **Dry-run flag** (`DRY_RUN=true` by default in new deployments) that logs the intended action without performing it. Roll out: dry-run in nonprod → live in nonprod → dry-run in prod → live in prod.
4. **Kill switch**: an SSM parameter (`/security/automation/<rule>/enabled`) checked at the start of every run, plus the ability to disable the EventBridge rule.
5. **Least-privilege remediation role** per function, permitted only the remediation actions on the resource types it handles, with `aws:ResourceTag`/account conditions; deployed via StackSets. No `iam:*`, no `*` resources.
6. **Idempotent and reversible**: record the previous state (e.g. the removed SG rule) in the audit log so it can be restored.
7. **Rate limits / circuit breaker**: cap actions per hour; if exceeded, stop and page (protects against a bad rule mass-changing an estate).
8. **Never remediate the security tooling itself** (no loops that touch CloudTrail, Config, GuardDuty, the remediation roles).
9. **Audit**: every action → structured log (who/what/when/before/after/finding id), Security Hub note, notification.
10. **Tests**: unit tests with recorded events (positive, negative, exception-tagged, already-compliant) and an integration test in a sandbox account.

## 4. Example: revoke internet-open admin port (Lambda, Python, Powertools)

```python
import json, os, boto3
from aws_lambda_powertools import Logger
logger = Logger()
ADMIN_PORTS = {22, 3389}
OPEN = {"0.0.0.0/0", "::/0"}

def _enabled(ssm, name):
    return ssm.get_parameter(Name=name)["Parameter"]["Value"] == "true"   # plain String param, not a secret

@logger.inject_lambda_context
def handler(event, _ctx):
    ssm = boto3.client("ssm")
    if not _enabled(ssm, os.environ["KILL_SWITCH_PARAM"]):
        logger.warning("automation disabled by kill switch"); return
    dry_run = os.environ.get("DRY_RUN", "true") == "true"
    finding = event["detail"]["findings"][0]
    account = finding["AwsAccountId"]; region = finding["Region"]
    sg_id = finding["Resources"][0]["Id"].split("/")[-1]
    creds = boto3.client("sts").assume_role(
        RoleArn=f"arn:aws:iam::{account}:role/SecurityRemediation-SG", RoleSessionName="auto-remediate-sg")["Credentials"]
    ec2 = boto3.client("ec2", region_name=region, aws_access_key_id=creds["AccessKeyId"],
                       aws_secret_access_key=creds["SecretAccessKey"], aws_session_token=creds["SessionToken"])
    sg = ec2.describe_security_groups(GroupIds=[sg_id])["SecurityGroups"][0]
    if any(t["Key"] == "security-exception" for t in sg.get("Tags", [])):
        logger.info("exception tag present; notify only", extra={"sg": sg_id}); return
    to_revoke = []
    for p in sg["IpPermissions"]:
        lo, hi = p.get("FromPort", 0), p.get("ToPort", 65535)
        all_ports = p.get("IpProtocol") == "-1"
        if all_ports or any(lo <= port <= hi for port in ADMIN_PORTS):
            v4 = [r for r in p.get("IpRanges", []) if r["CidrIp"] in OPEN]
            v6 = [r for r in p.get("Ipv6Ranges", []) if r["CidrIpv6"] in OPEN]
            if v4 or v6:
                rule = {"IpProtocol": p["IpProtocol"], "IpRanges": v4, "Ipv6Ranges": v6}
                if not all_ports:
                    rule.update(FromPort=lo, ToPort=hi)
                to_revoke.append(rule)
    logger.info("planned revoke", extra={"sg": sg_id, "account": account, "rules": to_revoke, "dry_run": dry_run})
    if to_revoke and not dry_run:
        ec2.revoke_security_group_ingress(GroupId=sg_id, IpPermissions=to_revoke)
    # update Security Hub finding workflow + note, publish SNS notification (omitted for brevity)
```

The function never logs credentials; assumed-role credentials stay in memory. Review this code with `iac-security-review` and unit tests before deploying.

## 5. Example: GuardDuty crypto-mining → isolate (semi-automatic)

Step Functions: receive `CryptoCurrency:EC2/BitcoinTool.B!DNS` (severity ≥ 7) → snapshot volumes → tag instance `quarantine=pending` → notify on-call with approve/deny (task token) → on approve: detach from ASG (`--should-decrement-desired-capacity`), swap SGs to isolation SG, revoke the instance role's sessions → update finding → open incident (`cloud-incident-response`). Termination stays manual.

## 6. Reviewing existing automation

Check for: overly broad event patterns, remediation roles with `*`, no dry-run/kill switch, no rate limit, actions that delete, missing audit, functions that log full events containing sensitive data, unpinned dependencies, no tests. Report as an `iac-security-review` style list.

## Never

- Automate destructive actions (delete/terminate) or IAM entity deletion.
- Give remediation roles permissions to modify the security tooling, SCPs or themselves.
- Deploy new remediations straight to prod in live mode.
