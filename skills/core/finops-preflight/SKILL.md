---
name: finops-preflight
description: Estimate and control cost before creating or changing cloud resources on AWS, Azure or GCP - Infracost on Terraform plans, pricing calculators/APIs, budget alerts, and expensive-resource red flags (NAT, GPUs, cross-AZ/egress, provisioned throughput, logs). Use before any change that adds billable resources, or when asked "how much will this cost?".
---

# FinOps Preflight

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Every change that adds or resizes billable resources carries a cost estimate in its plan (`cloud-change-plan`). Above the threshold in `CLOUD.md` (default USD 100/month per change), stop and get explicit approval for the cost.

## 1. Estimate

**Terraform + Infracost** (preferred):

```bash
infracost breakdown --path . --format table
infracost diff --path . --compare-to infracost-base.json   # PR deltas
```

Infracost needs an API key for pricing lookups; it is the user's to configure (`infracost auth login`). Do not paste or store it. If Infracost is not available, estimate manually:

- AWS: Pricing API (`aws pricing get-products --service-code AmazonEC2 --region us-east-1 --filters ...`) or the AWS Pricing Calculator.
- Azure: Retail Prices API (no auth): `curl "https://prices.azure.com/api/retail/prices?\$filter=serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and skuName eq 'D4s v5'"` (if network allows), or the Azure Pricing Calculator.
- GCP: Cloud Billing Catalog API (`gcloud billing` + REST) or the Google Cloud Pricing Calculator.

State assumptions (hours/month = 730, traffic volumes, storage growth, request counts). Usage-based services (Lambda, Functions, Cloud Run, S3/Blob/GCS requests, data transfer) need an assumed usage file (`infracost-usage.yml`).

## 2. Red flags: always call out

| Item | Why |
| --- | --- |
| NAT Gateway / Azure NAT / Cloud NAT | Hourly + per-GB processing; one per AZ adds up; consider VPC endpoints / Private Link / Private Google Access |
| Data transfer | Cross-AZ, cross-region, internet egress; chatty microservices across zones; replication |
| GPUs / large instances | $1-$40+ per hour; require stop schedules and quotas |
| Managed Kubernetes | Control-plane fee (EKS per cluster-hour, AKS Standard/Premium tier, GKE cluster fee beyond free tier) + nodes + LB |
| Databases | Provisioned IOPS, multi-AZ doubles cost, Aurora I/O, Cosmos RU/s, Spanner nodes, BigQuery on-demand scans |
| Logs & metrics | CloudWatch Logs ingestion, Log Analytics ingestion, Cloud Logging beyond free; high-cardinality custom metrics |
| Idle resources | Unattached volumes/disks, idle LBs, unused Elastic/public IPs (AWS charges for all public IPv4), old snapshots |
| Provisioned AI throughput | Bedrock provisioned throughput, Azure OpenAI PTUs, Vertex provisioned throughput: thousands per month |
| Premium support/features | Defender plans per resource, Security Hub/GuardDuty per volume, SCC tiers |
| Multi-region | Doubles compute + replication + transfer |

## 3. Guardrails to put in place

- **Budgets with alerts** on every account/subscription/project (actual 80%/100%, forecast 100%).
  - AWS: `aws budgets create-budget` (IaC: `aws_budgets_budget`), Cost Anomaly Detection monitors.
  - Azure: `az consumption budget create` (IaC: `azurerm_consumption_budget_subscription`), Cost Management anomaly alerts.
  - GCP: `gcloud billing budgets create --billing-account=... --budget-amount=...` (IaC: `google_billing_budget`) with Pub/Sub notifications.
- **Sandbox auto-cleanup**: `expires-on` tag + scheduled cleanup; nightly stop schedules for dev compute (Instance Scheduler, Azure Automation start/stop, GCE instance schedules).
- **Quotas** as a hard stop for GPUs / large SKUs in nonprod.
- Budget actions that *stop* resources automatically are destructive: design them with the user and apply only to sandbox.

## 4. Output in the change plan

```
Cost delta: +$412/month (Infracost, assumptions: 730h, 200 GB egress, 50M requests)
  + aws_nat_gateway x3          $98.55 + $0.045/GB processed
  + aws_db_instance (r6g.large, Multi-AZ)  $263
  + aws_lb                       $16.43 + LCU
Threshold: $100 → needs approval
Cheaper options: single NAT in nonprod (-$65), gp3 instead of io2 (-$40)
```

## Never

- Purchase commitments (Savings Plans, Reserved Instances/Capacity, CUDs) or change billing settings: these are financial decisions for humans. You may analyse and recommend (`aws-cost-optimization`, `azure-cost-management`, `gcp-cost-optimization`).
- Disable budgets/alerts or raise quotas without approval.
