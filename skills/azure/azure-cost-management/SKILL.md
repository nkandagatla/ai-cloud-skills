---
name: azure-cost-management
description: Analyse and reduce Azure spend - Cost Management queries and exports, top cost drivers by service/resource group/tag, Azure Advisor cost recommendations, reservations and savings plan analysis, idle and orphaned resources, VM/AKS/database rightsizing, storage tiering, Log Analytics costs, budgets and anomaly alerts. Use for Azure cost reviews, bill spikes, or optimisation plans.
---

# Azure Cost Management

Load `cloud-guardrails` and `finops-preflight`. Analysis is read-only. Resource changes go through `cloud-change-plan`; **reservations and savings plans are human purchase decisions**.

## 1. Where is the money going?

Cost Management Query API via `az rest` (works without extensions):

```bash
az rest --method post \
  --url "https://management.azure.com/subscriptions/S/providers/Microsoft.CostManagement/query?api-version=2023-11-01" \
  --body '{
    "type": "ActualCost",
    "timeframe": "TheLastMonth",
    "dataset": {
      "granularity": "None",
      "aggregation": { "totalCost": { "name": "Cost", "function": "Sum" } },
      "grouping": [ { "type": "Dimension", "name": "ServiceName" } ],
      "sorting": [ { "direction": "descending", "name": "Cost" } ]
    }
  }' --query "properties.rows[:15]" -o table
```

Group by `ResourceGroupName`, `MeterCategory`, `ResourceId`, or tags (`{"type":"TagKey","name":"app"}`). For deeper analysis, set up **Cost Management exports** (FOCUS format) to a storage account and query with Fabric/Synapse/ADX or DuckDB locally on a downloaded export (no customer data in billing exports, but treat as confidential).

Anomalies: Cost Management anomaly alerts (subscription scope) and the `Anomalies` view; budgets: `az consumption budget list`.

## 2. Recommendations

```bash
az advisor recommendation list --category Cost --query "[].{impact:impact,problem:shortDescription.problem,resource:impactedValue,savings:extendedProperties.annualSavingsAmount,currency:extendedProperties.savingsCurrency}" -o table
```

Validate each against actual metrics (14-30 days) before proposing.

## 3. Optimisation checklist

**Compute**
- Rightsize VMs/VMSS (Advisor + CPU/memory p95), current generations (`v5`/`v6`), AMD/ARM (`Dpsv6`, Cobalt) where compatible.
- Deallocate nonprod on schedules (Start/Stop VMs v2, Automation, AKS cluster stop for dev, scale node pools to 0 for user pools).
- Spot VMs / Spot node pools for interruptible work.
- AKS: cluster autoscaler + right-sized requests (VPA recommendations), node pool SKUs, cost analysis add-on.
- App Service: consolidate apps onto fewer plans, Premium v3 vs v2 price/perf, scale-in rules, Flex Consumption for spiky functions.
- **Azure Hybrid Benefit** for Windows Server/SQL licences the org owns (licensing decision: human).

**Commitments (model only)**
- Reservations (VMs, SQL, Cosmos, App Service, Redis...) and **Azure savings plan for compute**: present utilisation of steady baseline, term, break-even; never purchase.
  `az rest --method get --url "https://management.azure.com/providers/Microsoft.Capacity/reservationOrders?api-version=2022-11-01"` (existing reservations, if permitted).

**Storage**
- Blob lifecycle management (Hot → Cool → Cold → Archive, delete old versions/snapshots), reserved capacity for large steady storage (human), Premium disks oversized → Standard SSD / Premium SSD v2, delete unattached managed disks and old snapshots (after confirmation).

**Databases**
- Azure SQL: serverless with auto-pause for dev, elastic pools for many small DBs, vCore rightsizing, Hyperscale reserved; Cosmos: autoscale max RU, serverless for low traffic, TTL, indexing policy trimming; PostgreSQL Flexible: burstable for dev, stop dev servers.

**Networking**
- Idle public IPs (all Standard public IPs bill), idle Application Gateways/Load Balancers, NAT gateway data processing, cross-region and internet egress, Azure Firewall SKU (Basic/Standard/Premium) per need, ExpressRoute circuit right-sizing.

**Monitoring**
- Log Analytics ingestion (see `azure-monitor`): biggest tables (`Usage | where TimeGenerated > ago(30d) | summarize GB=sum(Quantity)/1000 by DataType | order by GB desc`), Basic/Auxiliary logs, DCR filtering, Defender for Servers P2 includes 500 MB/day/server of security data ingestion benefit.

**Orphans (read-only finders via Resource Graph)**
```bash
az graph query -q "resources | where type =~ 'microsoft.compute/disks' and properties.diskState == 'Unattached' | project name, resourceGroup, sku=sku.name, gb=properties.diskSizeGB"
az graph query -q "resources | where type =~ 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration) and isnull(properties.natGateway) | project name, resourceGroup"
az graph query -q "resources | where type =~ 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine) and isnull(properties.privateEndpoint) | project name, resourceGroup"
az graph query -q "resources | where type =~ 'microsoft.web/serverfarms' and properties.numberOfSites == 0 | project name, resourceGroup, sku=sku.name"
az graph query -q "resources | where type =~ 'microsoft.compute/snapshots' and todatetime(properties.timeCreated) < ago(180d) | project name, resourceGroup, gb=properties.diskSizeGB"
```

## 4. Output

```
Scope: subscription acme-prod  Period: Sep 2026  Total: $31,420 (+8% MoM)
Top drivers: VMs 34%, Log Analytics 14%, SQL 13%, Bandwidth 7%
| # | Opportunity | Est. saving/mo | Effort | Risk | Action |
| 1 | 37 unattached Premium disks (owners confirmed) | $1,120 | S | Low | delete after snapshot (approval per id) |
| 2 | ContainerLog → Basic logs + DCR filter | $1,900 | M | Low | azure-monitor IaC |
| 3 | Compute savings plan 1yr for $6.5/h baseline | $2,300 | — | Commitment | Human decision |
```

## Never

- Purchase/exchange/cancel reservations or savings plans, change billing profiles or invoice settings.
- Delete "idle" resources without owner confirmation, backup/snapshot and approval naming each resource.
- Remove diagnostics, Defender plans, backups or zone redundancy for cost without owner + security decision.
