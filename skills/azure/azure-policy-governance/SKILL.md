---
name: azure-policy-governance
description: Azure governance and security posture - Azure Policy definitions/initiatives/assignments/exemptions, effects (audit, deny, modify, deployIfNotExists), remediation tasks, Microsoft Cloud Security Benchmark, Defender for Cloud plans and secure score, resource locks, Deployment Stacks deny settings, and landing-zone guardrails. Use when writing or reviewing policies, analysing non-compliance, or auditing Defender for Cloud posture.
---

# Azure Policy and Governance

Load `cloud-guardrails`. Policy assignments at management-group level affect every subscription below. Agents author and review policy-as-code and analyse compliance; assignments, exemptions and Defender plan changes ship via the platform team's pipeline. The guard blocks deleting assignments, creating exemptions, deleting locks and downgrading Defender plans.

## 1. Read current state

```bash
az policy assignment list --scope /providers/Microsoft.Management/managementGroups/acme --query "[].{name:name,display:displayName,mode:enforcementMode,def:policyDefinitionId}" -o table
az policy assignment list --subscription S --disable-scope-strict-match -o table
az policy exemption list --subscription S --query "[].{n:name,cat:exemptionCategory,expires:expiresOn,assignment:policyAssignmentId}" -o table
az policy state summarize --subscription S --top 10 --query "policyAssignments[].{a:policyAssignmentId,nc:results.nonCompliantResources}"
az policy state list --subscription S --filter "complianceState eq 'NonCompliant'" --top 50 --query "[].{res:resourceId,policy:policyDefinitionName,assignment:policyAssignmentName}" -o table
az security secure-scores list --query "[].{n:displayName,cur:score.current,max:score.max}" -o table
az security assessment list --query "[?status.code=='Unhealthy'].{n:displayName,res:resourceDetails.Id,sev:metadata.severity}" -o table
```

## 2. Effects: pick deliberately

| Effect | Use for | Notes |
| --- | --- | --- |
| `Audit` / `AuditIfNotExists` | Visibility, new rules during trial | No blocking |
| `Deny` | Hard guardrails: allowed locations, no public IPs on NICs in Corp, storage must disable public access, TLS 1.2 | Breaks deployments that violate: roll out after audit period |
| `DenyAction` | Prevent deletes of specific resource types (e.g. diagnostic settings) | |
| `Modify` | Add/inherit tags, set properties (e.g. disable public network access) | Needs managed identity + roles on assignment |
| `DeployIfNotExists` | Deploy diagnostic settings, Defender agents, private DNS zone records for private endpoints | Remediation tasks for existing resources |
| `Disabled` | Temporarily turn off a definition in an initiative | Requires justification |

Always parameterise effect (`"effect": "[parameters('effect')]"`) so the same definition can be audit in one scope and deny in another.

## 3. Custom policy example (deny storage accounts with shared key access)

```json
{
  "properties": {
    "displayName": "Storage accounts must disable shared key access",
    "mode": "Indexed",
    "parameters": { "effect": { "type": "String", "allowedValues": ["Audit", "Deny", "Disabled"], "defaultValue": "Audit" } },
    "policyRule": {
      "if": {
        "allOf": [
          { "field": "type", "equals": "Microsoft.Storage/storageAccounts" },
          { "anyOf": [
            { "field": "Microsoft.Storage/storageAccounts/allowSharedKeyAccess", "exists": "false" },
            { "field": "Microsoft.Storage/storageAccounts/allowSharedKeyAccess", "equals": true }
          ] }
        ]
      },
      "then": { "effect": "[parameters('effect')]" }
    }
  }
}
```

Prefer built-in definitions and initiatives (MCSB, CIS, NIST, ALZ policies) over custom ones: they are maintained by Microsoft. Find them: `az policy definition list --query "[?policyType=='BuiltIn' && contains(displayName,'public network access')].{n:name,d:displayName}" -o table`.

Manage as code: Enterprise Policy as Code (EPAC), ALZ Terraform/Bicep, or AVM policy modules; test with `what-if` and `enforcementMode: DoNotEnforce` first.

## 4. Rollout process for a new guardrail

1. Author definition + tests (deploy compliant and non-compliant resources in a sandbox subscription).
2. Assign at a sandbox MG with `Audit`; review compliance after a full evaluation cycle (`az policy state trigger-scan --subscription S` starts an on-demand scan).
3. Communicate to teams with the list of non-compliant resources and remediation guidance.
4. Assign with `Deny`/`Modify` to nonprod MGs, then prod, using `enforcementMode` and non-compliance messages (`--non-compliance-messages`).
5. Remediate existing resources (`az policy remediation create`) as a change.

## 5. Exemptions

Exemptions are risk acceptances: category `Waiver` or `Mitigated`, scoped to the specific resource, **with `expiresOn`**, description linking to the ticket and approver. Agents may draft exemption IaC for review; the guard blocks creating them directly.

## 6. Defender for Cloud

- Plans per subscription: Foundational CSPM (free), Defender CSPM (attack paths, agentless scanning), Servers P1/P2, Storage (malware scanning, sensitive data threat detection), Key Vault, Containers, Databases, App Service, Resource Manager, APIs, AI services.
- Continuous export of alerts/recommendations to Log Analytics / Event Hub; workflow automation (Logic Apps) for alerts (`azure-security-automation`).
- Regulatory compliance dashboard: `cloud-compliance-mapping`.
- Downgrading a plan to Free is guard-blocked.

## 7. Locks and Deployment Stacks

- `CanNotDelete` locks on platform RGs (hub network, Log Analytics, Key Vaults, backup vaults) and prod data resources. `ReadOnly` locks break many operations (e.g. listing storage keys, scaling): use sparingly.
- **Deployment Stacks** with `denySettingsMode: denyDelete` (or `denyWriteAndDelete`) protect stack-managed resources from out-of-band changes, with excluded principals for the pipeline.

## Never

- Delete or weaken policy assignments, create exemptions, remove locks, or disable Defender plans from an agent (guard-blocked).
- Switch deny policies to audit to unblock a deployment; fix the template or request a scoped, expiring exemption.
- Assign new deny policies directly to the root/prod management groups without an audit period.
