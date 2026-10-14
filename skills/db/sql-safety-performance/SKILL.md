---
name: sql-safety-performance
description: Write, review and optimise SQL safely across PostgreSQL, MySQL, SQL Server and Oracle - parameterisation, correct joins and NULL handling, pagination, transactions and isolation, locking and deadlocks, indexing strategy, reading EXPLAIN plans, N+1 queries from ORMs, query anti-patterns, and safe data-fix scripts. Use when writing or reviewing SQL, a query is slow, an ORM generates bad SQL, or a data fix is needed.
---

# SQL Safety and Performance

Load `db-guardrails` first. Dialect specifics: `postgresql`, `mysql`, `sql-server`.

## 1. Correctness rules

- **Parameterise** every value (`$1`, `?`, `@p1`, named binds). Identifiers (column/table names for sorting) come from an allow-list, never from input.
- Explicit column lists in `INSERT` and `SELECT`; no `SELECT *` in application code.
- `NULL` semantics: `= NULL` is never true; use `IS NULL`; `NOT IN (subquery)` with NULLs returns nothing; prefer `NOT EXISTS`.
- Joins: always qualify columns; check row multiplication (count before/after joins); `LEFT JOIN` + filter on the right table in `WHERE` turns it into an inner join (move the predicate into `ON`).
- Aggregations: every non-aggregated column in `GROUP BY`; `COUNT(*)` vs `COUNT(col)` (ignores NULLs).
- Time: store UTC (`timestamptz` / `datetime2` + offset discipline); half-open ranges `>= start AND < end` (no `BETWEEN` on timestamps).
- Money: `numeric/decimal`, never float.
- Pagination: **keyset** (`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50`) for large tables; `OFFSET` gets slower with depth.
- Upserts: `INSERT ... ON CONFLICT` (Postgres), `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL), `MERGE` (SQL Server/Oracle: use with `HOLDLOCK`/care for races).

## 2. Transactions and locking

- Keep transactions short; no network calls or user waits inside them.
- Default isolation is usually Read Committed (Postgres, SQL Server, Oracle) or Repeatable Read (MySQL InnoDB); know which. Use `SELECT ... FOR UPDATE` (or `UPDLOCK`) for read-modify-write, or optimistic locking with a version column.
- Deadlocks: access tables/rows in a consistent order; retry the whole transaction on deadlock/serialization errors (SQLSTATE `40P01`, `40001`; MySQL 1213; SQL Server 1205).
- Long-running `ALTER`/`CREATE INDEX` take locks: use online/concurrent variants (`db-migrations`).

## 3. Indexing

- Index for the queries you run: equality columns first, then range, then sort columns; covering indexes (`INCLUDE`) for hot read paths.
- Foreign keys need indexes on the referencing column (Postgres/Oracle don't create them automatically).
- Low-selectivity booleans rarely help alone; partial/filtered indexes do (`WHERE status = 'pending'`).
- Functions on indexed columns (`WHERE lower(email) = ...`, `DATE(created_at) = ...`) prevent index use: use expression indexes or rewrite as ranges.
- Leading wildcard `LIKE '%x'` can't use b-tree indexes: full-text or trigram indexes.
- Every index costs writes and storage: check unused indexes before adding more.

## 4. Reading plans

```sql
-- PostgreSQL (ANALYZE executes the query: only for SELECTs, nonprod or replica)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT ...;
-- MySQL 8
EXPLAIN ANALYZE SELECT ...;          EXPLAIN FORMAT=TREE SELECT ...;
-- SQL Server
SET STATISTICS IO, TIME ON;  -- plus actual execution plan in SSMS / Query Store
-- Oracle
EXPLAIN PLAN FOR SELECT ...; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
```

Look for: sequential/full scans on big tables, row estimate vs actual mismatches (stale statistics → `ANALYZE`/update stats), nested loops over large inputs, sorts/hash spilling to disk, key lookups per row. `EXPLAIN ANALYZE` on `UPDATE/DELETE` **executes** them: wrap in `BEGIN; ... ROLLBACK;` and only outside prod.

## 5. ORM pitfalls

- N+1 queries: eager-load/batch (JPA `@EntityGraph`/fetch join, EF Core `Include`/split queries, Django `select_related`/`prefetch_related`, SQLAlchemy `selectinload`, Prisma `include`).
- Loading whole entities to update one column; use targeted updates.
- Implicit transactions per statement in loops; batch.
- Turn on SQL logging locally to see what the ORM actually emits (never with bind values in prod logs).

## 6. Anti-patterns to flag in review

`SELECT *` in app code, string-built SQL, unbounded queries without `LIMIT`, `OFFSET` deep pagination, `OR` across different columns defeating indexes, `DISTINCT` hiding join bugs, correlated subqueries per row on large sets, `COUNT(*)` for existence (use `EXISTS`), triggers with hidden business logic, `NOLOCK` hints (dirty reads), cursor loops where set-based SQL works.

## 7. Data-fix script template

```sql
-- Ticket: OPS-1234  Author: <name>  Reviewed by: <name>
-- Target: <env>/<db>   Expected rows: 37
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- 1. Preview (must return 37)
SELECT COUNT(*) FROM invoices WHERE status = 'stuck' AND updated_at < now() - interval '2 days';

-- 2. Backup affected rows (if policy allows; contains data, drop after retention)
CREATE TABLE ops_1234_invoices_bak AS
  SELECT * FROM invoices WHERE status = 'stuck' AND updated_at < now() - interval '2 days';

-- 3. Change
UPDATE invoices SET status = 'pending_retry', updated_at = now()
WHERE status = 'stuck' AND updated_at < now() - interval '2 days';
-- psql prints UPDATE 37; if different: ROLLBACK;

COMMIT;
-- Rollback: UPDATE invoices i SET status = b.status, updated_at = b.updated_at FROM ops_1234_invoices_bak b WHERE i.id = b.id;
```

Agents prepare and test this on nonprod/local; production execution is by the pipeline/DBA (`db-guardrails`).

## Never

- Concatenate input into SQL, run unbounded writes, or `EXPLAIN ANALYZE` a write outside a rolled-back transaction.
- Add indexes or run heavy queries on production primaries without a plan and approval.
- Use `NOLOCK`/dirty reads to "fix" blocking.
