---
name: gcp-security-automation
description: Build guarded security auto-remediation on Google Cloud - Security Command Center notifications to Pub/Sub, Eventarc on Cloud Audit Logs, Cloud Run/Cloud Functions remediators with dedicated service accounts, log-based alerts, Workflows approvals, org policy and posture as preventive controls, with dry-run, scoping, kill switches and audit. Use when automating detection-to-response or reviewing remediation automation on GCP.
---

# GCP Security Automation (auto-remediation)

Load `cloud-guardrails`. Same principles as the AWS and Azure equivalents: prefer **preventive** controls (org policies, security posture, VPC-SC) so there is less to remediate; automate only reversible fixes; dry-run first; kill switch; least privilege; rate limits; audit; staged rollout. No automated deletion.

## 1. Mechanisms

| Need | Mechanism |
| --- | --- |
| Prevent misconfiguration | Org policies (managed + custom constraints), Security posture deployments (`gcp-org-policy-security`) |
| React to SCC findings | SCC **notification config** (filter) → Pub/Sub → Cloud Run service / function |
| React to control-plane changes | **Eventarc** trigger on Cloud Audit Logs (`methodName`, `serviceName`) → Cloud Run; or aggregated log sink → Pub/Sub |
| Human approval steps | **Workflows** with callbacks, or Chat/Slack interactive message → approve endpoint |
| Scheduled scans | Cloud Scheduler → Cloud Run job |

## 2. Guardrails for every remediator

1. **Narrow filters**: SCC notification filter on category + state + resource type + folder (`resource.folders.resource_folder` / project), e.g. `state="ACTIVE" AND category="OPEN_FIREWALL"`; Eventarc filtered on exact `methodName`.
2. **Exceptions**: skip resources with a validated security-exception tag/label (allow-list in Firestore/Secret-free config, not free text).
3. **Dry-run** env var default `true`; staged rollout sandbox folder → nonprod → prod.
4. **Kill switch**: an `ENABLED` flag (env var, or a value in Parameter Manager / Firestore so it can flip without a redeploy) read at the start of every run. Document how the owner flips it.
5. **Identity**: dedicated SA per remediator, **custom role** with only the needed permissions (e.g. `compute.firewalls.get`, `compute.firewalls.update`, `compute.networks.updatePolicy`) granted at the folder; no Editor/Owner; the SA cannot change IAM, org policies, logging or SCC.
6. **Reversible**: store the resource's previous config in the audit record.
7. **Rate limit / circuit breaker**: max actions per hour; exceed → stop and page.
8. **Audit**: structured JSON log (`jsonPayload.action`, `before`, `after`, `finding`), SCC finding **security marks** / mute state untouched (marks like `remediation=done` are fine), notification to the owner (label `owner`) and security channel.
9. **Idempotent**: re-delivered Pub/Sub messages must be safe; ack after processing; dead-letter topic.
10. **Tests**: recorded finding payloads; integration test in a sandbox project.

## 3. Example: OPEN_FIREWALL → disable the offending rule (Cloud Run, Python)

```python
import base64, json, os, logging
from flask import Flask, request
from google.cloud import compute_v1

app = Flask(__name__)
ADMIN = {"22", "3389"}

def covers_admin(allowed):
    for a in allowed:
        if a.I_p_protocol in ("all",): return True
        if a.I_p_protocol in ("tcp", "udp"):
            ports = list(a.ports) or ["0-65535"]
            for p in ports:
                lo, _, hi = p.partition("-"); hi = hi or lo
                if any(int(lo) <= int(x) <= int(hi) for x in ADMIN): return True
    return False

@app.post("/")
def handle():
    if os.environ.get("ENABLED", "false") != "true":
        return ("disabled", 200)
    dry_run = os.environ.get("DRY_RUN", "true") == "true"
    msg = json.loads(base64.b64decode(request.get_json()["message"]["data"]))
    finding = msg["finding"]
    if finding.get("category") != "OPEN_FIREWALL" or finding.get("state") != "ACTIVE":
        return ("ignored", 200)
    # resourceName: //compute.googleapis.com/projects/PROJECT/global/firewalls/RULE
    parts = finding["resourceName"].split("/")
    project, rule_name = parts[4], parts[-1]
    client = compute_v1.FirewallsClient()
    fw = client.get(project=project, firewall=rule_name)
    if "0.0.0.0/0" in fw.source_ranges and fw.direction == "INGRESS" and not fw.disabled and covers_admin(fw.allowed):
        record = {"action": "disable-firewall-rule", "project": project, "rule": rule_name,
                  "before": {"disabled": fw.disabled, "sourceRanges": list(fw.source_ranges)}, "dry_run": dry_run,
                  "finding": finding.get("name")}
        logging.warning(json.dumps(record))
        if not dry_run:
            client.patch(project=project, firewall=rule_name, firewall_resource=compute_v1.Firewall(disabled=True)).result()
    return ("ok", 200)
```

Disabling (not deleting) the rule is reversible. The Cloud Run service is internal-only, invoked by the Pub/Sub push subscription's SA with `roles/run.invoker`; OIDC token audience verified.

Note: the `compute_v1` Python client exposes the protocol field as `I_p_protocol`; verify field names against the client library version you pin.

## 4. Example: SA key created (should never happen) → disable key + page

Eventarc on `google.iam.admin.v1.CreateServiceAccountKey` → remediator disables the key (`iam.serviceAccountKeys.disable`, reversible), records it, pages security, opens an incident (`cloud-incident-response`). Preventive control: org policy disabling key creation.

## 5. Reviewing existing automation

Flag: remediator SAs with basic roles or `iam.*`/`orgpolicy.*` permissions, functions publicly invokable, no dry-run/kill switch, deletes, missing audit, unfiltered notification configs (all findings), secrets in env vars, unpinned dependencies, no dead-letter topic.

## Never

- Automate deletion of projects, resources, data, SAs or IAM bindings beyond the specific offending grant.
- Let remediators modify org policies, SCC configuration, logging sinks, VPC-SC or their own IAM.
- Make remediation endpoints public (`allUsers` invoker is guard-blocked).
