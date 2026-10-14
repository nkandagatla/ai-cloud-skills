---
name: cloud-incident-response
description: Incident triage and response on AWS, Azure and GCP - outages, performance degradation, failed deploys, and security incidents such as leaked credentials, public data exposure, crypto-mining or suspicious IAM activity. Read-only investigation first, containment with approval, evidence preservation and blameless postmortems. Use when something is broken or a security alert fires.
---

# Cloud Incident Response

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Stay calm and boring. Investigate read-only. Every containment or fix is a change that follows `cloud-change-plan` with a lighter, faster approval, but **still** an explicit approval. In production the agent proposes; the incident commander (a human) decides.

## 1. Open the incident

Capture in one message:

```
Incident: <title>       Severity: SEV1|SEV2|SEV3|SEV4
Started: <time UTC>     Detected by: <alert / user / ...>
Impact: <who/what is affected, how badly>
Environment: <cloud / account|sub|project / region>
Commander: <human>      Scribe: agent
```

Severity guide: SEV1 customer-facing outage or confirmed data breach; SEV2 major degradation or likely security compromise; SEV3 partial/minor; SEV4 no customer impact.

Keep a timeline (UTC) of every observation and action.

## 2. Operational incidents: triage path

1. **What changed?** Recent deploys, IaC applies, config changes, scaling events, provider incidents.
   - AWS: CloudTrail `lookup-events` (last 2h, filter by resource or user), Health Dashboard `aws health describe-events --filter eventStatusCodes=open` (us-east-1 endpoint, Business support+).
   - Azure: `az monitor activity-log list --offset 2h --query "[].{t:eventTimestamp,op:operationName.value,who:caller,status:status.value}" -o table`; Service Health `az rest` or portal.
   - GCP: `gcloud logging read 'logName:"cloudaudit.googleapis.com%2Factivity"' --freshness=2h --limit=50 --format="table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)"`; status.cloud.google.com.
2. **Golden signals** for the affected service: latency, traffic, errors, saturation (`aws-observability`, `azure-monitor`, `gcp-observability`).
3. **Dependencies**: DB connections/CPU, queue depth, downstream 5xx, DNS, certificates expiry, quotas/limits (`service-quotas`, `az vm list-usage`, `gcloud compute regions describe`).
4. **Form a hypothesis**, test it with one read-only query, iterate.
5. **Mitigate** (fastest safe option, in order of preference): roll back the last change → shift traffic / fail over → scale out → feature-flag off → restart (last, it destroys evidence).

## 3. Security incidents

Security incidents need a human security lead. Notify the contact in `CLOUD.md` immediately. Preserve evidence: do not delete resources, logs, or instances; snapshot before changing.

### 3a. Credential exposure (key in repo, log, chat, ticket, public paste)

Order matters: **revoke first**, then investigate.

| Credential | Contain (human-approved) | Investigate |
| --- | --- | --- |
| AWS access key | `aws iam update-access-key --access-key-id AKIA... --status Inactive --user-name U`, then attach `AWSDenyAll`-style inline deny or revoke sessions for roles (`Revoke active sessions` = deny policy with `aws:TokenIssueTime`) | CloudTrail by `accessKeyId`, all regions, last 90 days; GuardDuty findings |
| Azure client secret / cert | `az ad app credential delete --id APPID --key-id KEYID`; revoke sessions `az rest --method POST --url https://graph.microsoft.com/v1.0/users/{id}/revokeSignInSessions` for users | Entra sign-in logs (service principal), Activity Log by caller |
| GCP SA key | `gcloud iam service-accounts keys disable KEY_ID --iam-account SA` | Audit logs `protoPayload.authenticationInfo.serviceAccountKeyName` |
| Kube token / kubeconfig | Rotate the SA token / delete the secret; for cloud-auth clusters revoke the IAM principal | K8s audit logs |
| Third-party token | Revoke in the provider console | Provider audit log |

Then: rotate dependent secrets, purge from git history (`git filter-repo` by a human; assume it was copied anyway), add the preventive control that would have stopped it.

### 3b. Public data exposure

Confirm read-only (bucket policy status / ACLs / public access settings / access logs). Containment: re-enable Block Public Access / public access prevention / disable public network access, by a human or via approved change. Determine what was accessed from access logs (S3 server access logs / CloudTrail data events, Storage analytics logs, GCS data access logs). Legal/privacy decides on notification.

### 3c. Compromised compute (crypto-mining, C2 traffic, unexpected processes)

1. Do not terminate. **Isolate**: swap security group to an isolation SG with no ingress/egress (AWS), apply isolation NSG / remove from LB (Azure), apply deny-all firewall tags / remove external IP (GCP). Remove from autoscaling/LB first so it is not replaced.
2. **Preserve**: snapshot disks, capture memory if your tooling supports it, export relevant logs.
3. **Revoke** the instance identity's sessions (role session revocation, managed identity role removal, SA token).
4. Investigate how it got in (exposed port, vulnerable image, leaked key).
5. Rebuild from known-good IaC/images; never "clean" in place.

### 3d. Suspicious IAM activity

Signals: new admin grants, new users/keys, disabled logging, unusual regions, `GetSecretValue` storms, `ListBuckets` from new IPs. Contain by disabling the principal (human-approved). Review all changes that principal made (`lookup-events` by user / Activity Log by caller / audit logs by principal) and revert through IaC.

Security tooling to consult (read-only): GuardDuty, Security Hub, Detective, IAM Access Analyzer; Defender for Cloud, Sentinel; Security Command Center, Event Threat Detection.

## 4. Communication

Status update template (every 30 min SEV1, 60 min SEV2):

```
[<SEV>] <title> — <Investigating|Identified|Mitigating|Monitoring|Resolved>
Impact: <current>
Since last update: <facts>
Next: <actions, owner, ETA>
Next update: <time>
```

No speculation about root cause or attackers in external comms. No secrets, keys, or personal data in any update.

## 5. Close and learn

Postmortem (blameless) within 5 business days:

```markdown
# Postmortem: <title>
Summary • Impact (duration, users, data) • Timeline (UTC) • Root cause(s) • Contributing factors
What went well • What went poorly • Where we got lucky
Action items (owner, due date, ticket): prevent / detect / mitigate
```

Typical action items: add the missing alarm, add a preventive policy (SCP / Azure Policy / org policy), add a guard custom rule, automate the runbook (`*-security-automation`), add a test.

## Never during an incident

- Delete logs, trails, findings, snapshots, or compromised resources.
- Disable security controls "to reduce noise".
- Paste credentials, tokens, customer data or full log dumps into chat or tickets.
- Make undocumented changes; everything goes in the timeline.
