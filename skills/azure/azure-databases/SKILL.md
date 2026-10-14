---
name: azure-databases
description: Secure and operate Azure databases - Azure SQL Database/Managed Instance, Azure Database for PostgreSQL/MySQL Flexible Server, Cosmos DB, Azure Cache for Redis - Entra-only authentication, private endpoints, TDE with CMK, auditing, Defender for SQL, backups/PITR/LTR, geo-replication and failover groups, scaling and performance troubleshooting. Use for database provisioning, connectivity, performance, failover or restores on Azure.
---

# Azure Databases

Load `cloud-guardrails`. Databases are one-way doors. Query only what is needed for diagnosis; never paste personal data from results.

## 1. Azure SQL baseline

- **Microsoft Entra-only authentication** (`azuread_authentication_only = true`), Entra admin = a group (PIM).
- `public_network_access_enabled = false` + private endpoint; no `0.0.0.0-255.255.255.255` rule (guard-blocked). "Allow Azure services" (`0.0.0.0` rule) is broad too: avoid.
- Minimum TLS 1.2; TDE on (service-managed or CMK in Key Vault with auto-rotation).
- Auditing to Log Analytics / storage (server level); Defender for SQL (vulnerability assessment + Advanced Threat Protection).
- Zone redundancy for prod; failover groups for regional DR (read-write listener endpoint for apps).
- Backups: PITR retention 7-35 days, LTR (weekly/monthly/yearly) per compliance; backup storage redundancy (GZRS/ZRS) per residency.
- Apps connect with managed identity (`Authentication=Active Directory Managed Identity` / `Default`), contained database users mapped to identities, least-privilege DB roles.

## 2. PostgreSQL / MySQL Flexible Server baseline

- Private access (VNet integration, delegated subnet + private DNS zone) or private endpoint; no public access in prod.
- Entra authentication (PostgreSQL: Entra + optionally disable password auth); admin password, if it must exist, generated and stored in Key Vault, never in IaC.
- `require_secure_transport = ON`, TLS 1.2+.
- Zone-redundant HA for prod; geo-redundant backup or read replicas in paired region for DR.
- Server parameters via IaC; `pgaudit` for PostgreSQL audit; Query Store / Query Performance Insight.
- Maintenance window set.

## 3. Cosmos DB baseline

- `disableLocalAuth: true` (Entra RBAC data plane: Cosmos DB built-in data roles via `az cosmosdb sql role assignment create`), `publicNetworkAccess: Disabled` + private endpoints.
- `disableKeyBasedMetadataWriteAccess: true` (control plane through ARM RBAC only).
- Continuous backup (7 or 30 days PITR); multi-region with automatic failover for prod; consistency level chosen deliberately.
- Throughput: autoscale RU/s with max set (cost guard); partition key designed for even distribution.
- Defender for Azure Cosmos DB.

## 4. Azure Cache for Redis / Azure Managed Redis

Private endpoint, `publicNetworkAccess: Disabled`, non-TLS port disabled, Entra authentication (access keys disabled where supported), zone redundancy, data persistence for Premium/Enterprise if needed.

## 5. Read-only operations

```bash
az sql server list --query "[].{n:name,rg:resourceGroup,public:publicNetworkAccess,tls:minimalTlsVersion,entraOnly:administrators.azureAdOnlyAuthentication}" -o table
az sql db list -g RG -s SERVER --query "[].{n:name,sku:currentSku.name,zr:zoneRedundant,status:status,backup:requestedBackupStorageRedundancy}" -o table
az sql server firewall-rule list -g RG -s SERVER -o table
az sql failover-group list -g RG -s SERVER -o table
az sql db ltr-policy show -g RG -s SERVER -n DB
az postgres flexible-server list --query "[].{n:name,ver:version,ha:highAvailability.mode,net:network.publicNetworkAccess,state:state}" -o table
az postgres flexible-server parameter show -g RG -s SERVER -n require_secure_transport
az cosmosdb list --query "[].{n:name,local:disableLocalAuth,public:publicNetworkAccess,backup:backupPolicy.type,regions:length(locations)}" -o table
az monitor metrics list --resource RESOURCE_ID --metric cpu_percent dtu_consumption_percent --interval PT5M --aggregation Average
```

Never `az cosmosdb keys list`, `list-connection-strings`, `az redis list-keys` (guard-blocked).

## 6. Changes (follow `cloud-change-plan`)

| Change | Safety notes |
| --- | --- |
| Scale SKU/vCores | Online for most Azure SQL tiers (brief connection drop at switch); Flexible Server compute scaling restarts the server |
| Failover group failover | Planned failover is data-safe; forced failover can lose data: human decision in prod |
| PITR restore | Always **to a new database/server**, validate, then cut over or copy data back |
| Parameter changes | Static params need restart; test in nonprod |
| Major version upgrade (PostgreSQL) | In-place major upgrade causes downtime; test on a restored copy first |
| Cosmos partition key change | Requires new container + data migration (container copy) |
| Firewall rule addition | Only specific IPs for break-glass, time-bound, documented; never to 255.255.255.255 |

## 7. Performance triage

- Azure SQL: Query Store (top resource-consuming queries, regressed plans), `sys.dm_exec_requests` / `sys.dm_os_wait_stats`, Intelligent Insights, automatic tuning recommendations (`az sql db advisor`), DTU/vCore saturation, log IO limits.
- PostgreSQL: Query Performance Insight, `pg_stat_statements`, `pg_stat_activity` blocking chains, autovacuum, connection count (use PgBouncer built-in).
- Cosmos DB: 429 rate (`TotalRequests` by `StatusCode`), normalized RU consumption per partition (hot partitions), RU charge per query; indexing policy.

## Never

- Enable public network access with open firewall ranges, SQL auth with shared passwords, or key-based Cosmos access (guard-blocked where detectable).
- Delete servers/databases/accounts in prod, shorten backup retention or disable geo-redundant backups from an agent.
- Restore over an existing production database.
- Run heavy ad-hoc queries on prod primaries; use a readable secondary / replica with approval.
