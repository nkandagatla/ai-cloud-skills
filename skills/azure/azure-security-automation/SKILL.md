---
name: azure-security-automation
description: Build guarded security auto-remediation on Azure - Defender for Cloud workflow automation and continuous export, Azure Policy remediation (modify/deployIfNotExists), Event Grid on Activity Log/Key Vault events, Logic Apps/Functions/Automation runbooks with managed identities, Sentinel automation rules and playbooks, with dry-run, scoping, kill switches and audit. Use when automating detection-to-response or reviewing remediation automation on Azure.
---

# Azure Security Automation (auto-remediation)

Load `cloud-guardrails`. The same principles as `aws-security-automation`: precise triggers, reversible actions, dry-run first, kill switch, least-privilege identity, rate limits, audit, staged rollout. Destructive actions are never automated.

## 1. Choose the mechanism

| Need | Mechanism | Notes |
| --- | --- | --- |
| Keep configuration compliant (add tags, disable public network access, deploy diagnostic settings) | **Azure Policy** `Modify` / `DeployIfNotExists` + remediation tasks | Declarative, auditable, built-in identity per assignment; preferred |
| React to Defender for Cloud alerts/recommendations | **Workflow automation** → Logic App | Trigger on alert severity / recommendation |
| React to control-plane events (role assignment to Owner, NSG rule open to Internet) | **Activity Log alert** → action group → Function/Logic App, or Event Grid system topic on subscription events | Near-real-time |
| SOC response (incident enrichment, user/IP containment) | **Microsoft Sentinel** automation rules + playbooks (Logic Apps) | Approval steps via Teams adaptive cards |
| Scheduled scans/fixes | Automation account runbooks / Functions timer | With managed identity |

## 2. Guardrails for every automation

1. **Trigger precision**: filter on alert type/severity, resource type, subscription list, and exclude resources tagged with a validated `security-exception` (allow-list stored in App Configuration / Key Vault as data, not free text).
2. **Dry-run parameter** default `true`; staged rollout: nonprod dry-run → nonprod live → prod dry-run → prod live.
3. **Kill switch**: Logic App disabled state or an App Configuration flag checked first; documented in runbook.
4. **Identity**: user-assigned managed identity per automation, custom role with only the needed actions at the narrowest scope (e.g. `Microsoft.Network/networkSecurityGroups/securityRules/delete` + `read` on landing-zone subscriptions). No Owner/Contributor.
5. **Reversible**: store the previous configuration (rule JSON) in the audit record so it can be restored.
6. **Rate limit**: max actions per hour; exceed → stop + page.
7. **No self-modification**: automation cannot touch policies, Defender settings, diagnostic settings, its own identity or Sentinel.
8. **Audit**: structured record to Log Analytics custom table (what, why, before, after, alert id); update the Defender alert / Sentinel incident with a comment.
9. **Secrets**: none. Logic App connections use managed identity; no stored API keys in workflow definitions.
10. **Tests**: recorded alert payloads (positive, negative, exception-tagged), and a sandbox subscription integration test.

## 3. Example: NSG rule opening RDP/SSH to the Internet → remove (Function, Python)

Trigger: Activity Log alert on `Microsoft.Network/networkSecurityGroups/securityRules/write` (Succeeded) → action group → Function (webhook, authenticated with Entra / function key stored in the action group as secure webhook).

```python
import os, json, logging
import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.mgmt.network import NetworkManagementClient

ADMIN_PORTS = {"22", "3389", "*"}
OPEN = {"*", "internet", "0.0.0.0/0", "any"}

def _ports(rule):
    return {rule.destination_port_range} | set(rule.destination_port_ranges or [])

def _covers_admin(ports):
    for p in ports:
        if p in ADMIN_PORTS: return True
        if p and "-" in p:
            lo, hi = map(int, p.split("-"))
            if lo <= 22 <= hi or lo <= 3389 <= hi: return True
    return False

def main(req: func.HttpRequest) -> func.HttpResponse:
    if os.environ.get("AUTOMATION_ENABLED", "false") != "true":
        return func.HttpResponse("disabled", status_code=200)
    dry_run = os.environ.get("DRY_RUN", "true") == "true"
    alert = req.get_json()
    rid = alert["data"]["essentials"]["alertTargetIDs"][0]            # .../networkSecurityGroups/NSG/securityRules/RULE
    parts = rid.strip("/").split("/")
    sub, rg, nsg, rule_name = parts[1], parts[3], parts[7], parts[9]
    client = NetworkManagementClient(DefaultAzureCredential(), sub)
    rule = client.security_rules.get(rg, nsg, rule_name)
    nsg_obj = client.network_security_groups.get(rg, nsg)
    if (nsg_obj.tags or {}).get("security-exception") in set(os.environ.get("EXCEPTIONS", "").split(",")) - {""}:
        logging.info(json.dumps({"action": "skip-exception", "rule": rid})); return func.HttpResponse("exception", status_code=200)
    src = {(rule.source_address_prefix or "").lower()} | {s.lower() for s in (rule.source_address_prefixes or [])}
    if rule.direction == "Inbound" and rule.access == "Allow" and src & OPEN and _covers_admin(_ports(rule)):
        record = {"action": "remove-nsg-rule", "rule": rid, "before": rule.as_dict(), "dry_run": dry_run}
        logging.warning(json.dumps(record))                            # goes to App Insights / LA
        if not dry_run:
            client.security_rules.begin_delete(rg, nsg, rule_name).result()
    return func.HttpResponse("ok", status_code=200)
```

Deleting the offending **rule** (not the NSG) is reversible from the logged `before` JSON. Notify the owner (tag `owner`) and the security channel.

## 4. Example: Defender alert on suspicious VM activity → isolate (semi-automatic)

Workflow automation → Logic App: snapshot OS disk → apply isolation NSG (deny all except Bastion) to the NIC → post Teams adaptive card to on-call with Approve/Reject before the isolation step in prod → comment on the alert → open incident (`cloud-incident-response`). Never delete or deallocate automatically.

## 5. Policy-based remediation

```bash
az policy remediation create --name rem-diag-kv-$(date +%Y%m%d) --policy-assignment ASSIGNMENT_ID \
  --resource-discovery-mode ReEvaluateCompliance --location-filters eastus --subscription S
az policy remediation show --name NAME --subscription S --query "{state:provisioningState,deployments:deploymentStatus}"
```

Remediation tasks are changes: scope by location/resource group, run in nonprod first, review `deploymentStatus` failures.

## 6. Reviewing existing automation

Flag: Logic Apps with API keys in definitions or stored connection secrets, broad identities (Contributor/Owner), no dry-run/kill switch, delete actions, missing audit, triggers without filters, unbounded loops over all resources.

## Never

- Automate deletion of resources, identities or data; deallocation of prod VMs; disabling users without approval.
- Give automation identities rights over policies, Defender, diagnostic settings, Sentinel or themselves.
- Put credentials in Logic App definitions or Function app settings in plain text.
