---
name: postgresql
description: Operate and troubleshoot PostgreSQL (self-managed, RDS/Aurora, Azure Flexible Server, Cloud SQL/AlloyDB) safely - psql usage, roles and privileges, connection pooling, pg_stat_statements and pg_stat_activity diagnostics, locks and blocking, vacuum/bloat, indexes, configuration, replication lag, extensions, backups and upgrades. Use for any PostgreSQL query, performance, locking, connection or maintenance question.
---

# PostgreSQL

Load `db-guardrails` first. Cloud-specific provisioning: `aws-databases`, `azure-databases`, `gcp-databases`.

## 1. Connect safely

```bash
psql "host=orders-dev.internal dbname=orders user=readonly sslmode=verify-full" -X -A -t
# password: from IAM token / .pgpass (managed by the user) / secret manager, never on the command line
```

Session hygiene for diagnostics:

```sql
SET default_transaction_read_only = on;   -- belt and braces for read-only work
SET statement_timeout = '30s';
SET lock_timeout = '3s';
SET application_name = 'agent-diagnostics';
```

## 2. Diagnostics (read-only)

```sql
-- Version, size, connections
SELECT version();
SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database ORDER BY pg_database_size(datname) DESC;
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
SHOW max_connections;

-- Top queries (needs pg_stat_statements)
SELECT round(total_exec_time::numeric/1000,1) AS total_s, calls, round(mean_exec_time::numeric,1) AS mean_ms,
       rows, left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;

-- Active / long-running queries (query text may contain data: summarise)
SELECT pid, usename, state, wait_event_type, wait_event, now() - query_start AS runtime, left(query, 100)
FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid() ORDER BY runtime DESC NULLS LAST LIMIT 20;

-- Blocking chains
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid, now() - blocked.query_start AS waiting,
       left(blocked.query, 80) AS blocked_q, left(blocking.query, 80) AS blocking_q
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));

-- Table bloat / vacuum health
SELECT relname, n_live_tup, n_dead_tup, round(100.0*n_dead_tup/greatest(n_live_tup,1),1) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 15;

-- Unused indexes (check across all replicas before dropping)
SELECT schemaname, relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC LIMIT 20;

-- Cache hit ratio, replication lag
SELECT sum(blks_hit)*100.0/nullif(sum(blks_hit)+sum(blks_read),0) AS hit_pct FROM pg_stat_database;
SELECT client_addr, state, write_lag, flush_lag, replay_lag FROM pg_stat_replication;     -- on primary
SELECT now() - pg_last_xact_replay_timestamp() AS replica_delay;                         -- on replica

-- Transaction ID wraparound risk
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
```

psql meta-commands: `\dt+`, `\d+ table`, `\di+`, `\dx` (extensions), `\du` (roles), `\x auto`.

## 3. Common problems

| Symptom | Check / safe fix |
| --- | --- |
| `too many connections` | Pooling (PgBouncer transaction mode, RDS Proxy, built-in poolers), lower app pool sizes, idle-in-transaction sessions (`idle_in_transaction_session_timeout`) |
| Slow query | `EXPLAIN (ANALYZE, BUFFERS)` on replica/nonprod; missing index, stale stats (`ANALYZE table`), bad estimates, function on indexed column |
| Lock waits | Blocking query above; long transactions; DDL without `lock_timeout`; ask owner before terminating (`pg_cancel_backend` first; `pg_terminate_backend` is a prod change) |
| Bloat / growing table | Autovacuum settings per table (`autovacuum_vacuum_scale_factor`), long transactions holding xmin, `pg_repack` (approved change) |
| Wraparound warning | Urgent: page DBA; ensure vacuum can run; find long transactions/replication slots holding xmin |
| Replication slot disk growth | Inactive slots (`SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots`) |

## 4. Changes (nonprod with approval; prod via pipeline/DBA)

- Indexes: `CREATE INDEX CONCURRENTLY` (outside a transaction), then check `indisvalid`.
- Parameters: through the managed service's parameter group / IaC; many need restart.
- Extensions: only approved ones (`pg_stat_statements`, `pgcrypto`, `pg_trgm`, `postgis`, `pgaudit`); `CREATE EXTENSION` is a change.
- Major upgrades: `pg_upgrade`/managed blue-green; test extensions and query plans first.

## 5. Security baseline

`ssl` required (`sslmode=verify-full` clients), `password_encryption = scram-sha-256`, no `trust` in `pg_hba.conf` beyond local admin, least-privilege roles (`db-access-control`), `pgaudit` for regulated data, row-level security for multi-tenant tables, revoke `CREATE` on `public` schema from `PUBLIC` (default in 15+).

## Never

- Run `VACUUM FULL`, `REINDEX` (non-concurrent), `CLUSTER` or large `ALTER TABLE` on prod hot tables from an agent (exclusive locks).
- Terminate sessions, drop replication slots, or change `pg_hba.conf`/parameters in shared environments without approval.
- Disable `fsync`/`synchronous_commit` or autovacuum to "speed things up".
