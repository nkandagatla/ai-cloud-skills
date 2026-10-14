---
name: cloud-dr-backup
description: Backup, restore and disaster recovery on AWS, Azure and GCP - RPO/RTO tiers, AWS Backup, Azure Backup/Site Recovery, GCP Backup and DR, immutable and cross-region/cross-account copies, ransomware protection and restore drills. Use when designing DR, auditing backups, or restoring data.
---

# Cloud DR and Backup

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

A backup that has never been restored is a hope, not a backup. This skill designs protection from RPO/RTO targets, verifies it, and runs restore drills **into isolated targets**, never over production.

## 1. Set targets per workload

| Tier | RPO | RTO | Typical pattern |
| --- | --- | --- | --- |
| Platinum | ≈0-1 min | < 15 min | Multi-region active/active or hot standby (Aurora Global, Cosmos multi-region writes, Spanner multi-region) |
| Gold | ≤ 15 min | < 1-4 h | Warm standby / pilot light in second region + continuous replication / PITR |
| Silver | ≤ 24 h | < 24 h | Daily backups copied cross-region; restore via IaC |
| Bronze | ≤ 7 d | days | Weekly backups; rebuild from IaC |

Record targets in `CLOUD.md` or the service README. Ask the user for the business owner's targets; do not invent them.

## 2. Protection checklist

- **Everything stateful is covered** by a backup plan/policy selected by **tags** (e.g. `backup=gold`), so new resources are protected automatically.
- **3-2-1-1**: 3 copies, 2 media/services, 1 off-site (other region), 1 immutable/air-gapped (other account/subscription/project + lock).
- **Immutability**: AWS Backup Vault Lock (compliance mode after testing) / S3 Object Lock; Azure Backup immutable vaults + soft delete + multi-user authorization (Resource Guard); GCP Backup and DR backup vaults with enforced retention, GCS bucket lock / soft delete.
- **Separate blast radius**: backup copies in a dedicated backup account / subscription / project with separate admins.
- **Encryption** with keys that survive the primary region/account (multi-region KMS keys, Key Vault in paired region, Cloud KMS in target region).
- **Point-in-time recovery** on databases (RDS/Aurora PITR, DynamoDB PITR, Azure SQL PITR + LTR, Cosmos continuous backup, Cloud SQL PITR, Spanner PITR, Firestore PITR).
- **Infrastructure** is reproducible from IaC in the DR region (parameterised region, AMIs/images replicated, container images replicated, DNS failover plan).
- **Secrets & config** replicated (Secrets Manager replica secrets, Key Vault backup/restore within geography, Secret Manager replication policy).
- **Monitoring**: alert on failed/missed backup jobs and on retention/lock changes.

## 3. Service map

| | AWS | Azure | GCP |
| --- | --- | --- | --- |
| Central backup | AWS Backup (plans, vaults, Vault Lock, cross-account/region copy, restore testing) | Azure Backup (Recovery Services / Backup vaults, policies, immutability, cross-region restore) | Backup and DR Service (backup vaults, plans) |
| VM DR | Elastic Disaster Recovery (DRS) | Azure Site Recovery | Backup and DR / regional MIG + images |
| Object storage | S3 Versioning + Replication (CRR/SRR) + Object Lock | Blob versioning, soft delete, object replication, immutability policies | GCS versioning, soft delete, dual/multi-region buckets, bucket lock |
| Relational DB | Snapshots, PITR, Aurora Global Database, cross-region read replicas | PITR, LTR, geo-replication / failover groups | Automated backups, PITR, cross-region replicas |
| NoSQL | DynamoDB PITR, on-demand backups, global tables | Cosmos DB continuous backup, multi-region | Firestore PITR/backups, Bigtable backups, Spanner backups |
| DNS failover | Route 53 health checks, ARC | Traffic Manager / Front Door | Cloud DNS routing policies, global LB |

## 4. Audit existing protection (read-only)

```bash
# AWS
aws backup list-backup-plans
aws backup list-protected-resources --query "Results[].{arn:ResourceArn,type:ResourceType,last:LastBackupTime}" --output table
aws backup list-backup-jobs --by-state FAILED --by-created-after $(date -u -d '-7 days' +%FT%TZ)
aws backup describe-backup-vault --backup-vault-name VAULT --query "{locked:Locked,min:MinRetentionDays}"
aws rds describe-db-instances --query "DBInstances[].{id:DBInstanceIdentifier,ret:BackupRetentionPeriod,delprot:DeletionProtection}"

# Azure
az backup vault list --query "[].{name:name,rg:resourceGroup}" -o table
az backup item list -g RG -v VAULT --query "[].{item:properties.friendlyName,state:properties.protectionState,last:properties.lastBackupTime}" -o table
az dataprotection backup-instance list -g RG --vault-name BVAULT -o table

# GCP
gcloud backup-dr backup-vaults list --location=REGION
gcloud sql instances describe INSTANCE --format="value(settings.backupConfiguration)"
gcloud storage buckets describe gs://BUCKET --format="yaml(versioning,soft_delete_policy,retention_policy)"
```

Report gaps against the tier targets: unprotected stateful resources, retention too short, no cross-region copy, no immutability, failed jobs, keys only in one region.

## 5. Restore drills

Run at least quarterly for Gold/Platinum, yearly for others. Restore **into a separate, isolated environment** (sandbox account/subscription/project or isolated VPC), never over the source.

1. Pick a recovery point; record its timestamp (actual RPO).
2. Restore (AWS Backup `start-restore-job` / restore testing plans; Azure `az backup restore restore-disks` / `az dataprotection backup-instance restore`; GCP `gcloud sql backups restore` to a new instance / Backup and DR restore). This is a change: follow `cloud-change-plan` (sandbox tier).
3. Validate data integrity with an agreed query/checksum, not just "it started".
4. Measure elapsed time (actual RTO).
5. Clean up the restored copy (approved destructive step in sandbox).
6. Record: point, RPO achieved, RTO achieved, issues, follow-ups.

## 6. Regional failover runbook skeleton

```
Trigger: <who declares, criteria>
1. Freeze deploys.
2. Promote data tier in DR region (<exact commands>), confirm replication lag.
3. Scale up compute in DR (<IaC var / command>).
4. Switch traffic (<DNS / Front Door / global LB change>), TTLs pre-lowered to <n>s.
5. Verify (<synthetic checks>).
6. Communicate.
Failback: <reverse steps, data resync>
```

Failover and failback in production are executed by people; you prepare and review the runbook and verify each step read-only.

## Never

- Restore over a production resource or point a restore at prod endpoints.
- Shorten retention, remove vault locks, disable soft delete, or delete recovery points (guard-blocked).
- Store the only copy of backup encryption keys in the same account/region as the data.
