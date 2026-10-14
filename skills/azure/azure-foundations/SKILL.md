---
name: azure-foundations
description: Azure basics done safely - az CLI login and subscription targeting, tenants/management groups/subscriptions/resource groups hierarchy, Azure Landing Zones (CAF), subscription baseline (Defender, Activity Log export, policies, budgets, locks), resource providers and quotas. Use when starting Azure work, auditing a subscription, or when the target tenant/subscription is unclear.
---

# Azure Foundations

Load `cloud-guardrails`. Establish **tenant, subscription and identity** before every Azure task.

## 1. Sign-in and targeting

```bash
az login                                  # interactive (MFA); for devices: az login --use-device-code
az account list --query "[].{name:name,id:id,tenant:tenantId,default:isDefault}" -o table
az account set --subscription "acme-dev"  # changes local default only
az account show --query "{sub:name,id:id,tenant:tenantId,user:user.name,type:user.type}" -o table
```

Always pass `--subscription` in commands you propose, plus `-g` for resource-group scoped commands. Map subscriptions to tiers through `CLOUD.md`. Separate Azure CLI profiles per identity when needed: `AZURE_CONFIG_DIR=~/.azure-readonly az login`.

Never use `az login --service-principal -p <secret>` (guard-blocked); automation uses managed identity (`az login --identity`) or workload identity federation (`cicd-oidc`). `az account get-access-token` is guard-blocked because it prints a bearer token.

## 2. Hierarchy (reference: Azure Landing Zones)

```
Tenant Root Group
└── acme (intermediate root MG)
    ├── Platform
    │   ├── Identity      → sub-identity (domain controllers if any)
    │   ├── Management    → sub-management (Log Analytics, Automation, Sentinel)
    │   ├── Connectivity  → sub-connectivity (hub VNet / Virtual WAN, Firewall, DNS, ExpressRoute)
    │   └── Security      → sub-security (optional, Defender/Sentinel ops)
    ├── Landing zones
    │   ├── Corp          → app subs needing private connectivity
    │   └── Online        → internet-facing app subs
    ├── Sandbox           → isolated dev experimentation, budget-capped
    └── Decommissioned
```

Policies and RBAC are assigned at management groups and inherited. Deploy with the ALZ Bicep/Terraform accelerators (Azure Verified Modules). Governance details: `azure-policy-governance`.

## 3. Subscription baseline checklist (audit read-only)

| Control | Check |
| --- | --- |
| Activity Log exported to Log Analytics / storage | `az monitor diagnostic-settings subscription list --subscription S -o table` |
| Defender for Cloud plans on (Servers, Storage, Key Vault, Containers, Databases, ARM, App Service as needed) | `az security pricing list --query "value[].{plan:name,tier:pricingTier}" -o table` |
| Security contacts / alert notifications | `az security contact list` |
| Policy assignments inherited (ALZ / MCSB) | `az policy assignment list --disable-scope-strict-match --query "[].{n:displayName,scope:scope,mode:enforcementMode}" -o table` |
| Non-compliance summary | `az policy state summarize --subscription S --query "results.nonCompliantResources"` |
| Owners and privileged roles | `az role assignment list --all --include-inherited --role Owner --query "[].{who:principalName,type:principalType,scope:scope}" -o table` |
| Budgets | `az consumption budget list -o table` |
| Resource locks on critical RGs | `az lock list -o table` |
| Registered resource providers (only what is used) | `az provider list --query "[?registrationState=='Registered'].namespace" -o tsv` |
| Network Watcher enabled in used regions | `az network watcher list -o table` |
| Entra: MFA / Conditional Access / PIM in place | `azure-entra-rbac` |

## 4. Resource groups

- Group by **lifecycle** (resources deployed and deleted together), one environment per RG, region in the name (`rg-orders-prod-eastus`).
- Tags required on RGs (Policy can inherit them to resources).
- `CanNotDelete` locks on platform and prod data RGs; locks are removed only by the owning team (guard-blocks agent removal).

## 5. Quotas and providers

```bash
az vm list-usage --location eastus --query "[?currentValue>0].{name:name.localizedValue,used:currentValue,limit:limit}" -o table
az quota list --scope /subscriptions/S/providers/Microsoft.Compute/locations/eastus   # quota extension
```

Quota increases and provider registrations are changes; ask first.

## 6. Querying at scale: Azure Resource Graph

```bash
az graph query -q "resources | summarize count() by type | order by count_ desc | limit 20"
az graph query -q "resources | where type =~ 'microsoft.storage/storageaccounts' | project name, resourceGroup, subscriptionId, allowBlobPublicAccess=properties.allowBlobPublicAccess, minTls=properties.minimumTlsVersion"
az graph query -q "resourcecontainers | where type == 'microsoft.resources/subscriptions' | project name, subscriptionId, mg=properties.managementGroupAncestorsChain[0].name"
```

(Requires the `resource-graph` extension: `az extension add --name resource-graph`.)

## Never

- Use client secrets / `create-for-rbac` for automation (guard-blocked) or store them in files.
- Delete management groups, subscriptions or resource groups from an agent; remove locks; move subscriptions between management groups.
- Elevate to tenant root ("Access management for Azure resources" / `elevateAccess`, guard-blocked).
- Switch to an Owner identity because a Reader call failed; report the missing permission.
