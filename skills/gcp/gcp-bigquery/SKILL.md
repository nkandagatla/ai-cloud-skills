---
name: gcp-bigquery
description: Use and govern BigQuery safely - dataset/table IAM, authorized views and row/column-level security, policy tags and data masking, CMEK, dry runs and cost controls (maximum bytes billed, partitioning/clustering, reservations), query optimisation, data exfiltration controls (VPC-SC), audit logs and billing export analysis. Use when writing or reviewing BigQuery SQL, designing datasets/permissions, or controlling BigQuery cost.
---

# BigQuery

Load `cloud-guardrails`. BigQuery holds analytical copies of sensitive data and charges per byte scanned (on-demand). Always **dry-run** first, always cap bytes, never select personal data you do not need.

## 1. Query safety

```bash
bq query --use_legacy_sql=false --dry_run 'SELECT order_id, total FROM `acme-dw.sales.orders` WHERE order_date = "2026-10-01"'
bq query --use_legacy_sql=false --maximum_bytes_billed=10000000000 --format=prettyjson \
  'SELECT order_date, COUNT(*) AS n, SUM(total) AS revenue FROM `acme-dw.sales.orders` WHERE order_date BETWEEN "2026-09-01" AND "2026-09-30" GROUP BY 1 ORDER BY 1'
```

Rules for agent-written SQL:

- Select **only needed columns** (no `SELECT *`), filter on the **partition column**, aggregate rather than return rows.
- `LIMIT` does not reduce bytes scanned on non-clustered tables; partition/cluster filters do.
- Prefer aggregates and counts over row-level output; if rows are needed, mask/omit PII columns (emails, names, phone, addresses, IDs).
- Use `--maximum_bytes_billed` on every query; state the dry-run estimate and approximate cost before running (on-demand pricing per TiB scanned varies by region; look up current price).
- DML (`INSERT/UPDATE/DELETE/MERGE`), DDL (`CREATE/DROP/ALTER`), `bq rm`, `bq cp` overwrites, and exports (`EXPORT DATA`, `bq extract`) are changes. `bq rm` asks via the guard.
- Query results are data: never paste personal data into chat; summarise.

## 2. Dataset and table design

- Datasets per domain and sensitivity; location matches residency (`US`, `EU`, or region).
- **Partition** by date/timestamp (or integer range), `require_partition_filter = true` on big tables; **cluster** by common filter columns.
- Table expiration for staging/temp datasets; `default_partition_expiration_ms` where retention rules apply.
- CMEK on datasets with confidential data.
- Time travel window (2-7 days) and fail-safe understood; table snapshots for important states.

## 3. Access control

| Need | Mechanism |
| --- | --- |
| Team read access | `roles/bigquery.dataViewer` on the **dataset** (not project), + `roles/bigquery.jobUser` on the billing project |
| Share a subset | **Authorized views / authorized datasets / authorized routines** |
| Hide rows | **Row-level access policies** (`CREATE ROW ACCESS POLICY ... GRANT TO ("group:...") FILTER USING (region = "EU")`) |
| Hide/mask columns | **Policy tags** (Data Catalog taxonomies) + `roles/datacatalog.categoryFineGrainedReader` or **dynamic data masking** rules |
| External sharing | Analytics Hub listings with data egress restrictions |
| Prevent exfiltration | VPC Service Controls perimeter around BigQuery projects; org policy restricting cross-perimeter copies |

Never grant `allAuthenticatedUsers`/`allUsers` on datasets (guard-blocked generally), and avoid project-level `bigquery.dataOwner/Admin` for humans.

## 4. Cost controls

- Custom quotas: **query usage per day per user / per project** (Quotas page or `serviceusage` API) as a hard cap.
- On-demand vs **Editions/reservations** (autoscaling slots): commitments are human decisions; model with `INFORMATION_SCHEMA.JOBS`.
- Find expensive queries:

```sql
SELECT user_email, job_id, total_bytes_billed/POW(1024,4) AS tib, total_slot_ms/1000/3600 AS slot_hours, LEFT(query, 120) AS q
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) AND job_type = 'QUERY'
ORDER BY total_bytes_billed DESC LIMIT 20;
```

- Storage: long-term storage pricing applies automatically after 90 days unmodified; physical vs logical storage billing model per dataset (compression-heavy data often cheaper on physical).
- Materialized views / BI Engine for repeated dashboard queries; avoid `SELECT *` in scheduled queries.

## 5. Billing export analysis (cost questions for all of GCP)

```sql
SELECT service.description AS service, SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost
FROM `acme-billing.billing_export.gcp_billing_export_resource_v1_XXXX`
WHERE invoice.month = '202609'
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
```

## 6. Read-only inspection

```bash
bq ls --project_id=P
bq show --format=prettyjson P:dataset | jq '{location, access, defaultEncryptionConfiguration, defaultTableExpirationMs}'
bq show --schema --format=prettyjson P:dataset.table | jq '.[].name'
bq show --format=prettyjson P:dataset.table | jq '{timePartitioning, clustering, requirePartitionFilter, numBytes, numRows}'
bq ls --jobs=true --max_results=20 --all=false
```

`bq head` prints rows (data): only with approval and only for non-sensitive tables.

## Never

- Run queries without a dry run and a bytes cap, or `SELECT *` over large/unpartitioned tables.
- Export or copy sensitive datasets outside their perimeter/region, or to personal/local storage.
- Drop datasets/tables or overwrite tables from the agent without approval naming them (and never in prod).
- Paste query results containing personal data into chat, tickets or PRs.
