---
name: aws-databases
description: Secure and operate AWS databases - RDS and Aurora (PostgreSQL/MySQL/SQL Server), DynamoDB, ElastiCache/MemoryDB - private networking, encryption, IAM and Secrets Manager auth, backups/PITR, Multi-AZ and global replicas, parameter changes, upgrades, failover, performance troubleshooting. Use for database provisioning, connectivity, performance, upgrades or recovery on AWS.
---

# AWS Databases

Load `cloud-guardrails`. Databases are one-way doors: data loss is permanent. Never query or export customer data unless the user asks for a specific, scoped query, and never paste results containing personal data into chat.

## 1. RDS / Aurora baseline

```hcl
resource "aws_rds_cluster" "app" {
  cluster_identifier              = "orders-prod"
  engine                          = "aurora-postgresql"
  engine_version                  = "16.4"
  db_subnet_group_name            = aws_db_subnet_group.private_data.name
  vpc_security_group_ids          = [aws_security_group.db.id]   # ingress only from app SG on 5432
  storage_encrypted               = true
  kms_key_id                      = var.kms_key_arn
  manage_master_user_password     = true          # master secret in Secrets Manager, rotated
  master_username                 = "orders_admin"
  iam_database_authentication_enabled = true
  deletion_protection             = true
  backup_retention_period         = 14
  preferred_backup_window         = "03:00-04:00"
  copy_tags_to_snapshot           = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  skip_final_snapshot             = false
  final_snapshot_identifier       = "orders-prod-final"
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.pg.name   # rds.force_ssl = 1
  lifecycle { prevent_destroy = true }
}
```

Instances: ≥ 2 in different AZs for prod (Aurora) or `multi_az = true` (RDS); `publicly_accessible = false`; Performance Insights / Database Insights on (KMS-encrypted); Enhanced Monitoring; auto minor version upgrade in a maintenance window; RDS Proxy for Lambda / bursty connections.

## 2. DynamoDB baseline

- On-demand capacity unless traffic is predictable; auto scaling for provisioned.
- `point_in_time_recovery { enabled = true }`, `deletion_protection_enabled = true`.
- SSE with a customer managed key for sensitive data.
- Fine-grained IAM: actions per table/index, `dynamodb:LeadingKeys` condition for per-tenant isolation.
- Global tables for multi-region; streams for CDC; TTL for expiring data.
- VPC gateway endpoint; endpoint policy scoped.

## 3. ElastiCache / MemoryDB

Private subnets, in-transit encryption + AUTH / RBAC users (Redis/Valkey), at-rest encryption, Multi-AZ with automatic failover, snapshots for MemoryDB/persistent use.

## 4. Read-only operations

```bash
aws rds describe-db-clusters --query "DBClusters[].{id:DBClusterIdentifier,eng:Engine,ver:EngineVersion,status:Status,multiAZ:MultiAZ,enc:StorageEncrypted,delprot:DeletionProtection,backup:BackupRetentionPeriod,iamAuth:IAMDatabaseAuthenticationEnabled}" --output table
aws rds describe-db-instances --query "DBInstances[].{id:DBInstanceIdentifier,class:DBInstanceClass,public:PubliclyAccessible,az:AvailabilityZone,status:DBInstanceStatus}" --output table
aws rds describe-events --source-type db-cluster --duration 1440
aws rds describe-pending-maintenance-actions
aws rds describe-db-cluster-snapshots --db-cluster-identifier ID --query "DBClusterSnapshots[].{id:DBClusterSnapshotIdentifier,t:SnapshotCreateTime,type:SnapshotType}"
aws pi get-resource-metrics ...   # Performance Insights: top waits / SQL (digests, not data)
aws dynamodb describe-table --table-name T --query "Table.{status:TableStatus,mode:BillingModeSummary.BillingMode,items:ItemCount,size:TableSizeBytes,delprot:DeletionProtectionEnabled}"
aws dynamodb describe-continuous-backups --table-name T
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections ...
```

## 5. Changes (follow `cloud-change-plan`)

| Change | Safety notes |
| --- | --- |
| Instance class resize | Causes failover/restart; use `--apply-immediately` only in a window; Aurora: add reader of new size, fail over, remove old |
| Parameter group change | Static params require reboot; test in nonprod; some (e.g. `shared_buffers`) affect memory |
| Engine minor upgrade | Maintenance window; snapshot first |
| Engine major upgrade | **Blue/Green Deployments** (RDS/Aurora) for low-downtime switchover; test app compatibility; extensions |
| Storage | Increases are online but cannot be reduced; storage autoscaling max set |
| Failover test | `failover-db-cluster` in nonprod; prod only in agreed game days |
| Restore | Always **to a new instance/cluster/table** (PITR or snapshot), validate, then cut over. Never overwrite |
| DynamoDB capacity mode switch | Limited frequency; check cost |
| Credentials | Rotate via Secrets Manager (`rotate-secret`), apps re-read secret |

Connecting to run SQL: use IAM auth tokens or the Secrets Manager secret through the app role / Session Manager port forwarding to RDS Proxy; never paste the password. Read-only queries (`EXPLAIN`, `pg_stat_statements`, catalog views) for diagnosis; DDL/DML is a change with a rollback script.

## 6. Performance triage

1. Performance Insights / Database Insights: top wait events and top SQL by load.
2. CPU, `FreeableMemory`, `ReadIOPS/WriteIOPS`, `DiskQueueDepth`, `DatabaseConnections`, replica lag.
3. Postgres: `pg_stat_statements`, `pg_stat_activity` (blocking), autovacuum and bloat; MySQL: `performance_schema`, slow query log.
4. DynamoDB: `ThrottledRequests` by operation, hot partitions (CloudWatch Contributor Insights), GSI back-pressure.
5. Recommend: index (with `CREATE INDEX CONCURRENTLY` in Postgres), query rewrite, connection pooling (RDS Proxy), read replicas, caching.

## Never

- Make databases publicly accessible, open 5432/3306/1433 to the internet, disable deletion protection or delete without a final snapshot (guard-blocked).
- Delete snapshots/backups or disable PITR.
- Run unbounded `SELECT *`, exports or scans on prod tables, or paste query results with personal data.
- Store master passwords in Terraform, tfvars or code (`manage_master_user_password = true`).
