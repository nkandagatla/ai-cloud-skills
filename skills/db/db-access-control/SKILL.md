---
name: db-access-control
description: Design and review database access control - separate owner/migration/application/read-only/analyst roles, least-privilege grants per engine (PostgreSQL, MySQL, SQL Server, Oracle, MongoDB), cloud IAM database authentication, secret rotation, row-level security and column masking for personal data, audit logging, break-glass access and access reviews. Use when creating database users or roles, granting permissions, reviewing who can access data, or protecting personal data in databases.
---

# Database Access Control

Load `db-guardrails` and `secrets-and-identity` first. Grants are changes made through migrations or IaC (Terraform providers for PostgreSQL/MySQL/MSSQL/MongoDB Atlas), reviewed in a PR. The guard blocks agents from granting superuser/ALL/admin roles.

## 1. Role model (per database, per environment)

| Role | Can | Used by |
| --- | --- | --- |
| `owner` | Owns schema objects | Nobody logs in as it; migrations `SET ROLE` to it |
| `migrator` | DDL on the app schema | CI pipeline only (short-lived credentials) |
| `app_rw` | `SELECT/INSERT/UPDATE/DELETE` on app tables, `EXECUTE` on app functions | The application's identity |
| `app_ro` | `SELECT` on app tables | Read replicas, reporting services |
| `analyst` | `SELECT` on masked views / analytics schema | Humans, BI tools |
| `agent_ro` | `SELECT` on non-sensitive tables/views, catalog access, `pg_read_all_stats`-like | AI agents and diagnostics |
| `breakglass` | Elevated, time-bound | Humans via PIM/JIT, alerted on use |

One login per application per environment. No shared human accounts. No application using admin/superuser.

## 2. Engine examples

**PostgreSQL**

```sql
CREATE ROLE app_rw NOLOGIN;
GRANT USAGE ON SCHEMA app TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
CREATE ROLE orders_api LOGIN IN ROLE app_rw;      -- password managed by the platform / IAM auth (rds_iam, azure_ad, cloudsqlsuperuser-free IAM users)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

**MySQL**

```sql
CREATE USER 'orders_api'@'10.20.%' IDENTIFIED WITH caching_sha2_password BY '<set by secret manager rotation>' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders.* TO 'orders_api'@'10.20.%';
```
(The password placeholder is set by the rotation mechanism, never typed by you.)

**SQL Server / Azure SQL**

```sql
CREATE USER [id-orders-api-prod] FROM EXTERNAL PROVIDER;     -- managed identity
ALTER ROLE db_datareader ADD MEMBER [id-orders-api-prod];
ALTER ROLE db_datawriter ADD MEMBER [id-orders-api-prod];
GRANT EXECUTE ON SCHEMA::app TO [id-orders-api-prod];
```

**MongoDB**

```javascript
db.createRole({ role: "ordersApp", privileges: [{ resource: { db: "orders", collection: "" }, actions: ["find", "insert", "update", "remove"] }], roles: [] })
// assign to a user authenticated via Atlas IAM/OIDC/X.509; no root/readWriteAnyDatabase
```

## 3. Protect personal data

- **Row-level security** (Postgres `CREATE POLICY`, SQL Server security policies) for multi-tenant tables keyed on tenant id from the session.
- **Column protection**: views exposing masked columns to analysts/agents; SQL Server Dynamic Data Masking / Always Encrypted; MongoDB CSFLE/Queryable Encryption; application-level encryption for the most sensitive fields.
- **Separate analytics copies** with masking/pseudonymisation; agents query those, not production PII.
- Data classification tags on tables/columns (comments or catalog) feed access decisions.

## 4. Credentials and rotation

- Prefer IAM database authentication (RDS/Aurora IAM, Azure Entra, Cloud SQL IAM) for apps and humans.
- Otherwise secrets in a secret manager with automatic rotation (30-90 days); apps re-read secrets; no passwords in code/config files.
- Dual-user rotation (`app_a`/`app_b`) for zero-downtime rotation where the engine needs it.

## 5. Audit and review

- Enable audit logs for logins, privilege changes and access to sensitive tables (pgaudit, MySQL audit plugin / Aurora advanced auditing, SQL Server Audit / Azure SQL auditing, Atlas auditing).
- Quarterly access review: list roles and members, last login, unused accounts; remove stale access.

Read-only review queries:

```sql
-- PostgreSQL: who has what
SELECT grantee, table_schema, table_name, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1,2,3 ORDER BY 1 LIMIT 100;
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_';
-- MySQL
SELECT user, host, plugin, account_locked FROM mysql.user; SHOW GRANTS FOR 'orders_api'@'10.20.%';
-- SQL Server
SELECT dp.name, dp.type_desc, r.name AS role FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals dp ON dp.principal_id = m.member_principal_id;
```

## Never

- Grant superuser, `ALL PRIVILEGES`, `sysadmin`, `db_owner`, `root`, `WITH GRANT OPTION`, or `TO PUBLIC` to applications or agents (guard-blocked).
- Share one database login across services or people; use admin accounts for applications.
- Give agents or analysts direct access to raw personal data when a masked view works.
