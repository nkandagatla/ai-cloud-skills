---
name: sql-server
description: Operate and troubleshoot Microsoft SQL Server and Azure SQL safely - sqlcmd/Invoke-Sqlcmd without password leaks, Entra authentication, DMVs and Query Store diagnostics, blocking and deadlocks, wait statistics, indexes and statistics maintenance, tempdb, Always On/geo-replication lag, permissions and security baseline. Use for any SQL Server or Azure SQL query, performance, blocking or maintenance question.
---

# SQL Server and Azure SQL

Load `db-guardrails` first. Azure provisioning: `azure-databases`.

## 1. Connect safely

```bash
# Microsoft Entra (Azure SQL): interactive or default credential, no password
sqlcmd -S sql-orders-dev.database.windows.net -d orders --authentication-method ActiveDirectoryDefault -W -h -1
# go-sqlcmd also supports: --authentication-method ActiveDirectoryInteractive / ActiveDirectoryManagedIdentity
```

PowerShell: `Invoke-Sqlcmd -ServerInstance ... -Database ... -AccessToken (Get-AzAccessToken -ResourceUrl https://database.windows.net/).Token` keeps the token in memory (never print it). Never `-P <password>` on the command line (guard-blocked).

Read-only diagnostics: connect with `-K ReadOnly` / `ApplicationIntent=ReadOnly` to readable secondaries where available.

## 2. Diagnostics (read-only)

```sql
SELECT @@VERSION, DB_NAME(), SERVERPROPERTY('EngineEdition');

-- Top queries by CPU (Query Store, SQL 2016+ / Azure SQL)
SELECT TOP 15 q.query_id, rs.avg_cpu_time/1000 AS avg_cpu_ms, rs.count_executions,
       LEFT(qt.query_sql_text, 120) AS query
FROM sys.query_store_runtime_stats rs
JOIN sys.query_store_plan p ON p.plan_id = rs.plan_id
JOIN sys.query_store_query q ON q.query_id = p.query_id
JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
ORDER BY rs.avg_cpu_time * rs.count_executions DESC;

-- Currently running and blocking
SELECT r.session_id, r.blocking_session_id, r.status, r.wait_type, r.wait_time, r.cpu_time,
       DB_NAME(r.database_id) AS db, LEFT(t.text, 120) AS query
FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id <> @@SPID ORDER BY r.wait_time DESC;

-- Wait stats (what the server is waiting on)
SELECT TOP 15 wait_type, wait_time_ms/1000 AS wait_s, waiting_tasks_count
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE 'SLEEP%' AND wait_type NOT IN ('BROKER_TASK_STOP','CLR_AUTO_EVENT','XE_TIMER_EVENT','REQUEST_FOR_DEADLOCK_SEARCH','LAZYWRITER_SLEEP','SQLTRACE_BUFFER_FLUSH','WAITFOR','DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION')
ORDER BY wait_time_ms DESC;

-- Missing index suggestions (validate before creating; they overlap and ignore write cost)
SELECT TOP 10 d.statement, d.equality_columns, d.inequality_columns, d.included_columns, s.avg_user_impact
FROM sys.dm_db_missing_index_details d JOIN sys.dm_db_missing_index_groups g ON g.index_handle = d.index_handle
JOIN sys.dm_db_missing_index_group_stats s ON s.group_handle = g.index_group_handle ORDER BY s.avg_user_impact DESC;

-- Index fragmentation / usage, stats age
SELECT OBJECT_NAME(i.object_id) AS tbl, i.name, s.user_seeks, s.user_scans, s.user_updates
FROM sys.indexes i LEFT JOIN sys.dm_db_index_usage_stats s ON s.object_id = i.object_id AND s.index_id = i.index_id AND s.database_id = DB_ID()
WHERE OBJECTPROPERTY(i.object_id,'IsUserTable') = 1 ORDER BY s.user_updates DESC;

-- Deadlocks (system_health extended event)
SELECT TOP 5 xed.value('@timestamp','datetime2') AS ts
FROM (SELECT CAST(target_data AS xml) AS x FROM sys.dm_xe_session_targets t JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address WHERE s.name = 'system_health' AND t.target_name = 'ring_buffer') d
CROSS APPLY x.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS e(xed) ORDER BY ts DESC;
```

## 3. Common problems

| Symptom | Check / safe fix |
| --- | --- |
| Blocking | Head blocker from `blocking_session_id`; long transactions (`sys.dm_tran_active_transactions`); consider RCSI (`READ_COMMITTED_SNAPSHOT ON`, default in Azure SQL) |
| Parameter sniffing / plan regression | Query Store regressed queries; force last good plan (change), `OPTIMIZE FOR`, recompile hints carefully |
| High CPU | Top CPU queries, missing indexes, implicit conversions (`CONVERT_IMPLICIT` in plans) |
| tempdb contention | Multiple equally sized data files, version store growth from long RCSI transactions |
| Azure SQL throttling | DTU/vCore utilisation, `sys.dm_db_resource_stats`, log write percent; scale tier (cost) or optimise |
| Geo-replication lag | `sys.dm_geo_replication_link_status` |

## 4. Changes (nonprod with approval; prod via pipeline/DBA)

- Online index operations (`WITH (ONLINE = ON, RESUMABLE = ON)` where supported), statistics updates in maintenance windows (Ola Hallengren scripts on IaaS; automatic tuning in Azure SQL).
- `KILL <spid>` only after confirming the session owner; rollback of a killed long transaction can take as long as it ran.
- Query Store plan forcing is a change; document it.

## 5. Security baseline

Entra-only authentication where possible, contained database users mapped to managed identities, least-privilege roles (`db_datareader` + specific `GRANT EXECUTE` rather than `db_owner`), no `sysadmin` for apps, `xp_cmdshell` disabled (guard blocks enabling), TDE on, Auditing to Log Analytics/storage, Defender for SQL, `Always Encrypted` / Dynamic Data Masking for sensitive columns, TLS 1.2 minimum.

## Never

- Use `sa`/sysadmin for applications, enable `xp_cmdshell`, or `GRANT CONTROL SERVER`.
- `DBCC SHRINKDATABASE`/`SHRINKFILE` routinely, `WITH (NOLOCK)` to hide blocking, or index rebuilds offline on prod.
- Put passwords in `-P`, connection strings in code, or SSIS packages in git.
