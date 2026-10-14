---
name: gcp-cost-optimization
description: Analyse and reduce Google Cloud spend - billing export queries in BigQuery, top cost drivers by service/project/label/SKU, Recommender (idle VMs, rightsizing, idle disks/IPs, CUD recommendations), committed use discounts analysis, GKE/Cloud Run/Cloud SQL optimisation, storage classes, network egress, logging costs, budgets and alerts. Use for GCP cost reviews, bill spikes, or optimisation plans.
---

# GCP Cost Optimization

Load `cloud-guardrails` and `finops-preflight`. Analysis is read-only. Changes go through `cloud-change-plan`; **committed use discounts and billing changes are human decisions**.

## 1. Where is the money going?

Requires Cloud Billing **export to BigQuery** (standard + detailed usage). Queries cost bytes scanned: filter by `invoice.month` / `usage_start_time` partitions and use `--maximum_bytes_billed` (see `gcp-bigquery`).

```sql
-- Net cost by service, last month
SELECT service.description AS service,
       ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS net_cost
FROM `acme-billing.billing_export.gcp_billing_export_resource_v1_XXXX`
WHERE invoice.month = '202609'
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

-- What grew: by project and SKU, week over week
SELECT project.id, sku.description, DATE_TRUNC(DATE(usage_start_time), WEEK) AS wk, ROUND(SUM(cost),2) AS cost
FROM `acme-billing.billing_export.gcp_billing_export_resource_v1_XXXX`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 35 DAY)
GROUP BY 1,2,3 HAVING cost > 50 ORDER BY 1,2,3;

-- By label (allocation)
SELECT (SELECT value FROM UNNEST(labels) WHERE key = 'app') AS app, ROUND(SUM(cost),2) AS cost
FROM `acme-billing.billing_export.gcp_billing_export_resource_v1_XXXX`
WHERE invoice.month = '202609' GROUP BY 1 ORDER BY 2 DESC;
```

## 2. Recommender (read-only)

```bash
for r in google.compute.instance.IdleResourceRecommender google.compute.instance.MachineTypeRecommender \
         google.compute.disk.IdleResourceRecommender google.compute.address.IdleResourceRecommender \
         google.compute.image.IdleResourceRecommender google.cloudsql.instance.IdleRecommender \
         google.cloudsql.instance.OverprovisionedRecommender; do
  gcloud recommender recommendations list --project=P --location=us-central1-a --recommender=$r \
    --format="table(description,primaryImpact.costProjection.cost.units,stateInfo.state)" 2>/dev/null
done
gcloud recommender recommendations list --billing-account=BA --location=global --recommender=google.compute.commitment.UsageCommitmentRecommender
```

(Location varies by recommender: zone for instances/disks, region for addresses/Cloud SQL, global for some.) Validate each against metrics before proposing.

## 3. Optimisation checklist

**Compute**
- Rightsize (Recommender), E2/N2D/C4/C4A/T2A families for price-performance, custom machine types to avoid paying for unused memory/CPU.
- **Spot VMs** for batch/CI/stateless; MIG autoscaling to the floor; instance schedules to stop dev VMs.
- **Sustained use discounts** apply automatically on eligible families; **CUDs** (resource-based or spend-based flexible): model coverage of steady baseline, never purchase.

**GKE**
- Autopilot (pay per pod request) vs Standard bin-packing; right-size requests (VPA recommendations, GKE cost optimization insights); cluster autoscaler + node auto-provisioning; Spot node pools; scale dev clusters to zero; GKE cost allocation (namespace/label) in billing export.

**Serverless**
- Cloud Run: CPU allocated only during requests (`cpu_idle = true`), concurrency > 1, min instances only where latency requires, max instances as cost guard; CUDs for Cloud Run where steady.

**Data**
- Cloud SQL: rightsize, stop idle dev instances, Enterprise vs Enterprise Plus deliberately, HA only where needed (nonprod usually zonal), storage auto-increase limit.
- BigQuery: see `gcp-bigquery` (partitioning, bytes caps, editions vs on-demand).
- Cloud Storage: lifecycle to Nearline/Coldline/Archive, Autoclass, delete old noncurrent versions, watch soft-delete retention storage, minimum durations.

**Network**
- Egress to internet and cross-region; Cloud NAT data processing; inter-zone traffic for chatty services; Premium vs Standard network tier for non-critical traffic; Cloud CDN for cacheable content; release unused static external IPs.

**Observability**
- Logging ingestion and retention (exclusions/sampling, `gcp-observability`), Prometheus metric cardinality.

**Orphans (read-only finders)**
```bash
gcloud compute disks list --project=P --filter="-users:*" --format="table(name,zone.basename(),sizeGb,type.basename())"
gcloud compute addresses list --project=P --filter="status=RESERVED" --format="table(name,region.basename(),address)"
gcloud compute snapshots list --project=P --filter="creationTimestamp<'2025-10-01'" --format="table(name,diskSizeGb,creationTimestamp)"
gcloud compute images list --project=P --no-standard-images --format="table(name,family,creationTimestamp)"
gcloud compute instances list --project=P --filter="status=TERMINATED" --format="table(name,zone.basename())"   # stopped VMs still bill disks/IPs
```

## 4. Output

```
Billing account: XXXX  Period: Sep 2026  Net: $27,900 (+15% MoM)
Top drivers: Compute Engine 31%, BigQuery 22%, Cloud SQL 14%, Networking 9%
| # | Opportunity | Est. saving/mo | Effort | Risk | Action |
| 1 | BigQuery: partition filter on events (scans 40 TiB/day) | $4,100 | M | Low | gcp-bigquery |
| 2 | 23 idle persistent disks (owners confirmed) | $610 | S | Low | delete after snapshot (approval per disk) |
| 3 | 1-yr flexible CUD for $8/h baseline | $1,700 | — | Commitment | Human decision |
```

## Never

- Purchase CUDs, change billing accounts, unlink billing (guard-blocked), or modify budget actions.
- Delete idle resources without owner confirmation, snapshot/backup and approval naming each resource.
- Cut audit logging, backups, HA or security services for cost without owner + security decision.
