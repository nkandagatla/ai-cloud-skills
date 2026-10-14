---
name: mongodb
description: Operate and troubleshoot MongoDB (self-managed, Atlas, Amazon DocumentDB, Azure Cosmos DB for MongoDB) safely - mongosh usage without credential leaks, query and aggregation safety, indexes and explain plans, schema design and validation, profiler and currentOp diagnostics, write concerns, transactions, replica set and sharding health, users/roles and network security. Use for any MongoDB query, index, performance or administration question.
---

# MongoDB

Load `db-guardrails` first.

## 1. Connect safely

```bash
mongosh "mongodb+srv://cluster-dev.abcde.mongodb.net/orders" --username readonly --quiet   # password prompted, not in the URI
mongosh "mongodb+srv://cluster-dev.abcde.mongodb.net/orders?authMechanism=MONGODB-AWS" --quiet   # Atlas AWS IAM auth
```

Never put passwords in the URI (`mongodb://user:pass@`) or `-p <pw>` (guard-blocked). Prefer Atlas IAM/OIDC/X.509 auth; read from secondaries for analytics (`readPreference=secondaryPreferred`).

## 2. Query safety

- Always filter and limit: `db.orders.find({ status: "pending" }, { _id: 1, total: 1 }).limit(20)`; project only needed fields (no full documents with PII in the transcript).
- Type-check inputs in app code (operator injection: `{ "$ne": null }` in place of a string). Use schema validation and drivers' typed builders.
- Writes: preview with `countDocuments(filter)`, then `updateMany`/`deleteMany` with the same filter; never an empty filter `{}` (guard-blocked); prefer `bulkWrite` with explicit `_id`s for data fixes.
- `$where`, `mapReduce` with JS, `$function`/`$accumulator` on untrusted input: avoid.
- Aggregations: `$match` and `$project` early, `allowDiskUse` deliberately, `$out`/`$merge` write data (change).

## 3. Diagnostics (read-only)

```javascript
db.version(); db.serverStatus().connections; rs.status().members.map(m => ({ name: m.name, state: m.stateStr, lag: m.optimeDate }))
db.orders.find({ customerId: "c1" }).sort({ createdAt: -1 }).limit(20).explain("executionStats")   // IXSCAN vs COLLSCAN, docsExamined vs nReturned
db.orders.getIndexes()
db.orders.aggregate([{ $indexStats: {} }])                                  // index usage
db.currentOp({ active: true, secs_running: { $gt: 5 } })                    // long operations (contains query shapes)
db.system.profile.find().sort({ ts: -1 }).limit(10)                         // if profiler enabled (level 1, slowms)
db.orders.stats({ scale: 1024 * 1024 })                                     // size in MB
sh.status()                                                                 // sharded clusters
```

Atlas: Performance Advisor and Query Profiler in the UI/API (Atlas Admin API with a read-only key managed by the user).

## 4. Indexes and schema

- ESR rule: **E**quality fields, then **S**ort, then **R**ange in compound indexes.
- Index every query path used in production; `hidden` an index before dropping it to test impact.
- Build indexes on large collections in maintenance windows (rolling builds on replica sets, Atlas handles rolling).
- Model for access patterns: embed what is read together, reference unbounded/shared data; avoid unbounded arrays; document size < 16 MB.
- `$jsonSchema` validation on collections (`validationAction: "error"` after a `warn` period).
- TTL indexes for expiring data; partial indexes for sparse states.

## 5. Durability and transactions

- Write concern `w: "majority"` for important writes; read concern `majority` where correctness matters; retryable writes on.
- Multi-document transactions only when needed (keep them short; 60 s default limit).

## 6. Security baseline

Authentication on (no unauthenticated instances, ever), TLS, IP access lists / private endpoints (Atlas PrivateLink), least-privilege roles per app/database (`readWrite` on one DB, custom roles), no `root`/`*AnyDatabase` for apps (guard-blocked), encryption at rest (+ CSFLE/Queryable Encryption for sensitive fields), auditing (Enterprise/Atlas), backups with PITR.

## Never

- Empty-filter deletes/updates, `dropDatabase()`, `collection.drop()` from an agent (guard-blocked).
- Expose MongoDB to `0.0.0.0/0` (Atlas access list) or disable authentication.
- Dump full documents with personal data into the transcript; project and aggregate.
- `mongodump`/`mongoexport` production data to local machines (guard asks; needs data-handling approval).
