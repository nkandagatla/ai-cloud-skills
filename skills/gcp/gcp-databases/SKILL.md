---
name: gcp-databases
description: Secure and operate Google Cloud databases - Cloud SQL (PostgreSQL/MySQL/SQL Server), AlloyDB, Spanner, Firestore, Bigtable and Memorystore - private IP/PSC, IAM database authentication, Cloud SQL Auth Proxy/connectors, SSL enforcement, CMEK, backups/PITR, HA and cross-region replicas, deletion protection, maintenance, and performance troubleshooting. Use for database provisioning, connectivity, performance, failover or restores on GCP.
---

# Google Cloud Databases

Load `cloud-guardrails`. Databases are one-way doors. Query only for diagnosis, never paste personal data.

## 1. Cloud SQL baseline

```hcl
resource "google_sql_database_instance" "orders" {
  name                = "orders-prod-usc1"
  project             = var.project_id
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  encryption_key_name = var.cmek_key_id                 # if CMEK required
  settings {
    tier              = "db-custom-4-16384"
    edition           = "ENTERPRISE_PLUS"               # or ENTERPRISE
    availability_type = "REGIONAL"                      # HA for prod
    deletion_protection_enabled = true                  # API-level protection
    ip_configuration {
      ipv4_enabled    = false                           # no public IP (org policy sql.restrictPublicIp)
      private_network = var.network_id                  # or PSC: psc_config { psc_enabled = true, allowed_consumer_projects = [...] }
      ssl_mode        = "ENCRYPTED_ONLY"                # TRUSTED_CLIENT_CERTIFICATE_REQUIRED for mTLS
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7
      backup_retention_settings { retained_backups = 30 }
    }
    database_flags { name = "cloudsql.iam_authentication", value = "on" }
    database_flags { name = "log_min_duration_statement", value = "1000" }
    insights_config { query_insights_enabled = true }
    maintenance_window { day = 7, hour = 3, update_track = "stable" }
    user_labels = local.labels
  }
}
```

- Apps connect through **Cloud SQL Auth Proxy / language connectors** with **IAM database authentication** (`google_sql_user` type `CLOUD_IAM_SERVICE_ACCOUNT`) and `roles/cloudsql.client` + `roles/cloudsql.instanceUser`.
- Built-in users only for admin break-glass, password generated and stored in Secret Manager (never in IaC literals); password policy flags enabled.
- Cross-region read replica for DR (promote in a regional outage: human decision); Enterprise Plus offers near-zero-downtime maintenance and advanced DR (switchover).

## 2. Other engines

| Engine | Key settings |
| --- | --- |
| **AlloyDB** | Private IP/PSC, IAM auth, continuous backup + PITR, cross-region secondary cluster, read pools, CMEK |
| **Spanner** | Fine-grained access control (database roles), deletion protection (`enable_drop_protection`), backups + PITR (`version_retention_period`), multi-region configs for 99.999% |
| **Firestore** | Security rules (client SDK access) tested in emulator; IAM for server SDKs; PITR + scheduled backups; delete protection; App Check for client apps |
| **Bigtable** | IAM per instance/table, backups, replication with app profiles, deletion protection |
| **Memorystore (Redis/Valkey)** | Private service access/PSC, AUTH + in-transit encryption, IAM auth (Valkey/Cluster), HA tier |

## 3. Read-only operations

```bash
gcloud sql instances list --project=P --format="table(name,databaseVersion,region,settings.tier,settings.availabilityType,state)"
gcloud sql instances describe INSTANCE --project=P --format="yaml(settings.ipConfiguration,settings.backupConfiguration,settings.deletionProtectionEnabled,settings.databaseFlags)"
gcloud sql backups list --instance=INSTANCE --project=P --limit=10
gcloud sql operations list --instance=INSTANCE --project=P --limit=10
gcloud sql users list --instance=INSTANCE --project=P --format="table(name,type)"
gcloud alloydb clusters list --region=R --project=P
gcloud spanner instances list --project=P ; gcloud spanner databases describe DB --instance=I --format="yaml(enableDropProtection,versionRetentionPeriod)"
gcloud firestore databases list --project=P
```

Query Insights (Cloud SQL / AlloyDB) shows top queries by load with normalized SQL: use it before connecting.

## 4. Changes (follow `cloud-change-plan`)

| Change | Safety notes |
| --- | --- |
| Tier/machine change | Restart (seconds-minutes) for Cloud SQL; Enterprise Plus near-zero downtime |
| Flags | Some flags restart the instance; check docs per flag |
| Major version upgrade | In-place upgrade with downtime; test on a clone (`gcloud sql instances clone`) first; take on-demand backup |
| Failover test | `gcloud sql instances failover` in nonprod; game day only in prod |
| Restore | **To a new instance** (PITR clone or backup restore to a different instance), validate, cut over. Restoring onto an existing instance overwrites it: guard asks, prod denied |
| Replica promotion | Breaks replication permanently: human decision |
| Spanner/Firestore schema/index changes | Long-running operations; index builds consume resources |

## 5. Performance triage

1. Query Insights: top queries, wait events, tags (`sqlcommenter`).
2. CPU, memory, disk utilisation/IOPS, connections (`cloudsql.googleapis.com/database/postgresql/num_backends`), replication lag.
3. Postgres: `pg_stat_statements`, blocking (`pg_locks`), autovacuum; MySQL: performance_schema, slow log.
4. Spanner: Query stats / Lock stats / Key Visualizer for hotspots; Firestore: index exemptions, hotspotting on monotonically increasing keys.
5. Recommend: indexes, pooling (connector with pool, PgBouncer/Managed Connection Pooling where available), read replicas, caching.

## Never

- Enable public IP with `0.0.0.0/0` authorized networks or allow unencrypted connections (guard-blocked).
- Disable deletion protection, delete instances/backups, or reduce backup retention from an agent.
- Store DB passwords in IaC, env files or code; use IAM auth or Secret Manager.
- Run heavy queries on prod primaries; use replicas with approval.
