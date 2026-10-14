---
name: mysql
description: Operate and troubleshoot MySQL and MariaDB (self-managed, RDS/Aurora MySQL, Azure Flexible Server, Cloud SQL) safely - client usage without password leaks, performance_schema and sys schema diagnostics, slow query log, InnoDB locks and deadlocks, indexes, online DDL (INSTANT/INPLACE, gh-ost, pt-osc), replication lag, character sets, users and grants, backups and upgrades. Use for any MySQL/MariaDB query, performance, locking or maintenance question.
---

# MySQL and MariaDB

Load `db-guardrails` first.

## 1. Connect safely

```bash
mysql --defaults-extra-file=~/.my-readonly.cnf -h orders-dev.internal -D orders -B -N   # option file managed by the user
mysql -h orders-dev.internal -u readonly -p -D orders                                    # interactive prompt; no password on the line
```

Never `-pSecret` or `--password=Secret` (guard-blocked). RDS/Aurora: IAM auth tokens via the SDK/CLI are short-lived (still never paste them).

Session settings for diagnostics:

```sql
SET SESSION TRANSACTION READ ONLY;
SET SESSION MAX_EXECUTION_TIME = 30000;   -- ms, SELECTs only
SET SESSION innodb_lock_wait_timeout = 5;
```

## 2. Diagnostics (read-only)

```sql
SELECT VERSION(); SHOW VARIABLES LIKE 'innodb_buffer_pool_size';
SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW VARIABLES LIKE 'max_connections';

-- Top statements (performance_schema / sys)
SELECT query, exec_count, total_latency, avg_latency, rows_examined_avg
FROM sys.statement_analysis ORDER BY total_latency DESC LIMIT 15;

-- Full table scans and missing indexes
SELECT * FROM sys.statements_with_full_table_scans ORDER BY exec_count DESC LIMIT 10;
SELECT * FROM sys.schema_unused_indexes LIMIT 20;

-- Running queries and lock waits
SELECT id, user, db, command, time, state, LEFT(info, 100) FROM information_schema.processlist WHERE command <> 'Sleep' ORDER BY time DESC LIMIT 20;
SELECT * FROM sys.innodb_lock_waits\G
SHOW ENGINE INNODB STATUS\G       -- LATEST DETECTED DEADLOCK section; may contain row data: summarise

-- Table sizes
SELECT table_name, ROUND((data_length+index_length)/1024/1024,1) AS mb, table_rows
FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY mb DESC LIMIT 15;

-- Replication
SHOW REPLICA STATUS\G             -- Seconds_Behind_Source, Last_SQL_Error (8.0.22+; older: SHOW SLAVE STATUS)
```

## 3. Common problems

| Symptom | Check / safe fix |
| --- | --- |
| `Too many connections` | App pool sizes, `wait_timeout`, ProxySQL/RDS Proxy; never just raise `max_connections` blindly (memory) |
| Slow query | `EXPLAIN ANALYZE`; composite index order; implicit type conversions (`varchar` column compared to number); `ORDER BY ... LIMIT` without index |
| Deadlocks (1213) | Consistent access order, smaller transactions, indexes on `WHERE`/FK columns (gap locks), retry logic |
| Lock wait timeout (1205) | Long transactions (`information_schema.innodb_trx` ordered by `trx_started`), metadata locks from DDL (`performance_schema.metadata_locks`) |
| Replication lag | Large transactions, single-threaded apply (`replica_parallel_workers`), missing primary keys on replicated tables |
| Mojibake | Use `utf8mb4` everywhere (server, database, tables, connection `charset=utf8mb4`), collation `utf8mb4_0900_ai_ci` |

## 4. Changes (nonprod with approval; prod via pipeline/DBA)

- Online DDL: `ALTER TABLE t ADD COLUMN c INT NULL, ALGORITHM=INSTANT;` / `ADD INDEX ix (a,b), ALGORITHM=INPLACE, LOCK=NONE;` (statement fails instead of locking if not possible: good). Large tables: gh-ost or pt-online-schema-change (`db-migrations`).
- Killing a query (`KILL QUERY <id>`) is a change: confirm owner first; never `KILL` replication threads.
- Parameter changes via parameter groups / IaC.

## 5. Security baseline

`require_secure_transport=ON`, accounts per app with host restrictions (`'app'@'10.%'`), no `'%'` root, `caching_sha2_password`, no `GRANT ALL ON *.*`, `FILE`/`SUPER`/`PROCESS` only for admins (guard blocks granting them), `local_infile=OFF`, audit plugin where required, `sql_mode` strict (`STRICT_TRANS_TABLES`, `ONLY_FULL_GROUP_BY`).

## Never

- Passwords on the command line, `GRANT ALL`, `FLUSH PRIVILEGES` after manual `mysql.user` edits.
- Blocking `ALTER TABLE` on large prod tables, `OPTIMIZE TABLE` on hot tables, or disabling binary logging.
- `SELECT ... INTO OUTFILE` / `LOAD DATA LOCAL INFILE` with production data (guard asks).
