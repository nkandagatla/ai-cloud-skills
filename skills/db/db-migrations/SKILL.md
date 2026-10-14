---
name: db-migrations
description: Safe, zero-downtime database schema migrations with Flyway, Liquibase, Alembic, Django, Prisma, Knex, EF Core, golang-migrate and Rails - expand/contract pattern, backward compatibility with running code, online index and column changes per engine, large backfills, testing on production-like data, rollback strategy and pipeline application. Use when adding or reviewing a migration, changing a column/table/index, backfilling data, or a migration failed.
---

# Database Migrations

Load `db-guardrails` first. Schema changes ship as versioned migration files in the repo, reviewed in a PR, applied by the pipeline. Agents write and test migrations locally/nonprod; they do not apply them to production.

## 1. Rules for every migration

1. **Backward compatible** with the code currently running (deploys roll gradually; old and new code overlap). Use **expand → migrate → contract**.
2. **Small and single-purpose**; one migration per logical change; never edit a migration that has run anywhere shared (add a new one).
3. **Online**: no long exclusive locks on hot tables (see engine notes).
4. **Idempotent where the tool allows** (`IF NOT EXISTS`), and deterministic.
5. **Tested** on a copy with production-like volume (masked) to measure lock time and duration.
6. **Rollback plan**: a down migration or a forward fix; for destructive steps, a backup.
7. **Separate data backfills** from schema changes; backfill in batches, resumable.

## 2. Expand / contract examples

**Rename a column** (`fullname` → `display_name`):
1. Expand: add `display_name` (nullable). Deploy code that writes both, reads old.
2. Backfill `display_name` in batches.
3. Deploy code reading new, writing both. Then code writing only new.
4. Contract (later release): drop `fullname`.

**Make a column NOT NULL**: add with default/nullable → backfill → add constraint without validation (`NOT VALID` in Postgres, then `VALIDATE CONSTRAINT`) → set NOT NULL.

**Change type**: new column + dual write + backfill + switch reads + drop old.

**Drop a table/column**: stop using it in code (one release), then drop in a later migration (asks via the guard; never in the same release).

## 3. Engine notes (locking)

| Change | PostgreSQL | MySQL 8 (InnoDB) | SQL Server |
| --- | --- | --- | --- |
| Add nullable column | Fast (metadata) | `ALGORITHM=INSTANT` | Fast |
| Add column with default | Fast (11+, non-volatile default) | `INSTANT` in 8.0.12+ for many cases | Fast with constant default (Enterprise online) |
| Add index | `CREATE INDEX CONCURRENTLY` (not in a transaction) | `ALGORITHM=INPLACE, LOCK=NONE` | `WITH (ONLINE = ON)` (Enterprise/Azure SQL) |
| Add FK | `NOT VALID` then `VALIDATE CONSTRAINT` | Requires index; locks: test duration | `WITH NOCHECK` then check, or off-hours |
| Large table rewrite | Avoid; use pg_repack / new table + swap | gh-ost / pt-online-schema-change | Online rebuild / batch copy |
| Lock protection | `SET lock_timeout = '5s'` and retry | `SET SESSION lock_wait_timeout = 5` | `SET LOCK_TIMEOUT 5000` |

## 4. Tool specifics

| Tool | Create | Check before apply | Notes |
| --- | --- | --- | --- |
| Flyway | `V20261009_1__add_display_name.sql` | `flyway info`, `flyway validate` | `flyway migrate` by pipeline; `cleanDisabled=true` always |
| Liquibase | changeset with `id`/`author` | `liquibase status`, `update-sql` (preview) | rollback blocks per changeset |
| Alembic | `alembic revision --autogenerate -m "..."` (review the diff!) | `alembic upgrade head --sql` | Autogenerate misses renames (shows drop+add) |
| Django | `python manage.py makemigrations` | `sqlmigrate app 0042`, `migrate --plan` | `SeparateDatabaseAndState` for zero-downtime tricks |
| Prisma | `prisma migrate dev --name x` (local only) | `prisma migrate diff`, `migrate status` | `prisma migrate deploy` in pipeline; never `db push`/`migrate reset` on shared DBs |
| Knex | `knex migrate:make x` | `knex migrate:list` | |
| EF Core | `dotnet ef migrations add X` | `dotnet ef migrations script --idempotent` | Apply via bundle in pipeline, not `Database.Migrate()` at startup in multi-instance prod |
| golang-migrate / goose / Atlas | `migrate create -ext sql -dir db/migrations -seq x` | `atlas migrate lint` | Atlas lint catches destructive/locking changes |
| Rails | `bin/rails g migration X` | `strong_migrations` gem | |

`flyway clean`, `prisma migrate reset`, `liquibase drop-all`, `rails db:drop` wipe databases: local only; never against shared environments.

## 5. Backfills

```sql
-- PostgreSQL batch backfill, resumable
UPDATE users SET display_name = fullname
WHERE id IN (SELECT id FROM users WHERE display_name IS NULL ORDER BY id LIMIT 5000);
-- repeat until 0 rows; sleep between batches; monitor replication lag and locks
```

Run from a job/script with progress logging, rate limiting and a stop switch; not inside the schema migration transaction.

## 6. Review checklist

- [ ] Compatible with currently deployed code (expand/contract step named)
- [ ] No long locks on hot tables; online options used; lock timeout set
- [ ] Indexes for new FKs/queries; concurrent/online creation
- [ ] Down migration or documented forward fix; backup for destructive steps
- [ ] Tested on realistic volume; duration measured
- [ ] Data backfill separate, batched, resumable
- [ ] No data or secrets in migration files (seed data only for reference tables)

## Never

- Edit an applied migration, combine destructive changes with the release that stops using the column, or run migrations from a laptop against production.
- Use `flyway clean`, `migrate reset`, `db push`, `drop-all` outside local environments.
- Hold a transaction open across a large backfill.
