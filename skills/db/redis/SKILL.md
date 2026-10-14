---
name: redis
description: Operate and troubleshoot Redis and Valkey (self-managed, ElastiCache/MemoryDB, Azure Cache/Managed Redis, Memorystore) safely - redis-cli without password leaks, key design and TTLs, SCAN instead of KEYS, memory and eviction diagnostics, big/hot keys, latency and slowlog, persistence, replication and cluster health, ACLs and TLS, and safe bulk deletes. Use for any Redis/Valkey caching, session, queue, performance or administration question.
---

# Redis and Valkey

Load `db-guardrails` first.

## 1. Connect safely

```bash
redis-cli -h cache-dev.internal -p 6379 --tls --user readonly --askpass      # prompt, no password on the line
# REDISCLI_AUTH works only when the user sets it in their own environment; never inline it in a command
```

Never `-a <password>` or `--pass` on the command line (guard-blocked).

## 2. Read-only diagnostics

```bash
redis-cli ... INFO server | head -20
redis-cli ... INFO memory | grep -E 'used_memory_human|maxmemory_human|maxmemory_policy|mem_fragmentation_ratio'
redis-cli ... INFO stats | grep -E 'evicted_keys|expired_keys|keyspace_hits|keyspace_misses|instantaneous_ops_per_sec'
redis-cli ... INFO replication
redis-cli ... DBSIZE
redis-cli ... SLOWLOG GET 10
redis-cli ... LATENCY DOCTOR
redis-cli ... --bigkeys        # samples with SCAN; safe but adds load: off-peak on prod
redis-cli ... --memkeys
redis-cli ... MEMORY USAGE session:abc123
redis-cli ... SCAN 0 MATCH 'session:*' COUNT 100     # iterate; never KEYS * on prod (blocks the server)
redis-cli ... TTL session:abc123 ; TYPE session:abc123
```

Values may contain session tokens or personal data: inspect types, sizes and TTLs, not contents.

## 3. Design rules

- Namespaced keys: `app:entity:id[:field]` (`orders:cart:9f2c`).
- **Every cache key has a TTL**; jitter TTLs to avoid stampedes; use `SET key value EX 300 NX` patterns for locks (or Redlock carefully).
- Keep values small (< 100 KB typical); split big hashes/lists; avoid unbounded lists/streams (`XTRIM MAXLEN ~`).
- `maxmemory-policy` deliberate: `allkeys-lru`/`allkeys-lfu` for pure caches, `noeviction` for data you cannot lose (queues, locks) with alerts on memory.
- Cache-aside with fallback when Redis is down; Redis is not the system of record unless persistence/replication is designed for it.
- Pipelining for bulk reads/writes; Lua scripts short and deterministic.

## 4. Safe bulk delete (nonprod with approval; prod via runbook)

```bash
# preview count
redis-cli ... --scan --pattern 'tmp:import:*' | wc -l
# delete in batches with UNLINK (non-blocking), never FLUSHDB/FLUSHALL or KEYS
redis-cli ... --scan --pattern 'tmp:import:*' --count 1000 | xargs -r -n 500 redis-cli ... UNLINK
```

## 5. Common problems

| Symptom | Check / safe fix |
| --- | --- |
| Evictions / OOM | Memory usage vs `maxmemory`, big keys, missing TTLs, fragmentation; scale the node (cost) |
| Latency spikes | `SLOWLOG`, `KEYS`/`SMEMBERS`/`HGETALL` on big keys, fork for persistence (RDB/AOF) on large datasets, network |
| Low hit rate | Key design, TTLs too short, cache not warmed, wrong serialization causing misses |
| Connection exhaustion | Client pool sizes, `maxclients`, idle connections (`CLIENT LIST` count by `name`) |
| Replica lag / failover | `INFO replication`, managed service events |

## 6. Security baseline

AUTH/ACLs on (users per app with key-pattern and command restrictions, e.g. `~orders:* +@read +@write -@dangerous`), TLS in transit, no public exposure (private subnets/endpoints), `protected-mode yes`, rename/disable dangerous commands in self-managed setups (`FLUSHALL`, `CONFIG`, `DEBUG`), encryption at rest on managed services.

## Never

- `FLUSHALL`, `FLUSHDB`, `SHUTDOWN`, `DEBUG`, `CONFIG SET dir/dbfilename`, `REPLICAOF`, `MODULE LOAD` from an agent (guard-blocked).
- `KEYS *` on production; print values that may hold sessions/tokens/PII.
- Expose Redis to the internet or run it without AUTH/TLS.
