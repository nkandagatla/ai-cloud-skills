---
name: nodejs-backend
description: Company standard for Node.js services - LTS versions, project layout, Express/Fastify/NestJS security middleware, config and secrets, input validation, structured logging with pino, error handling and graceful shutdown, database access and connection pooling, performance (event loop, streams, worker threads), testing, Docker images and npm supply-chain hygiene. Use when building, reviewing or debugging Node.js APIs, workers or CLIs.
---

# Node.js Backend

Load `engineering-guardrails`, `secure-coding`, `code-fundamentals` and `javascript-typescript` first.

## 1. Runtime and layout

- Active **LTS** Node only (check `node --version`; pin in `.nvmrc`, `engines`, Dockerfile). TypeScript compiled with `tsc` or run with a supported loader; no `ts-node` in production.
- Layout: `src/` (`routes|controllers`, `services`, `repositories`, `lib`), `test/`, `config/` schema, one entry point. Keep business logic out of HTTP handlers.
- Configuration from environment validated at startup (zod); secrets from the secret manager injected as env or fetched with the workload identity; fail fast if missing.

## 2. HTTP security baseline (Express example)

```ts
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);                         // only behind a known proxy/LB
app.use(helmet());                                 // security headers incl. CSP defaults
app.use(express.json({ limit: "100kb" }));         // body size limit
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));
app.use(pinoHttp({ redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"] }));
```

- Validate every body/query/param with a schema (zod / Fastify JSON schema / class-validator in NestJS); reject unknown fields.
- AuthN with a proven library (OIDC/JWT verification with `jose`: check `iss`, `aud`, `exp`, algorithm allow-list); AuthZ per resource in the service layer.
- CORS: explicit origin allow-list; credentials only with specific origins.
- Cookies: `httpOnly`, `secure`, `sameSite: "lax"|"strict"`.
- Outbound HTTP: `fetch` with `AbortSignal.timeout(ms)`, retries with backoff for idempotent calls only, URL allow-list to prevent SSRF.
- Files: stream uploads to object storage with size/type limits; never write user paths directly.
- Child processes: `execFile`/`spawn` with argument arrays; never `exec` with input.

## 3. Errors, logging, shutdown

- Central error handler: map known errors to 4xx, log unknown ones with request id, return generic 500 without stack traces.
- `process.on("unhandledRejection")` / `uncaughtException`: log and exit non-zero (let the orchestrator restart); do not keep running in an unknown state.
- Structured JSON logs (pino) with `level`, `msg`, `reqId`, `traceId`; redact secrets/PII; no `console.log` in services.
- Graceful shutdown on `SIGTERM`: stop accepting connections, finish in-flight requests (timeout), close DB pools, then exit.
- OpenTelemetry auto-instrumentation for traces/metrics where the platform supports it.

## 4. Data access

- Use a pooled client (`pg.Pool`, `mysql2/promise` pool, Prisma/Drizzle/Knex/TypeORM). One pool per process; size it below the DB's max connections divided by instance count (serverless: RDS Proxy / PgBouncer / Data API).
- Parameterised queries only; migrations via the project's tool (`db-migrations`).
- Transactions for multi-step writes; idempotency keys for retried operations.

## 5. Performance

- Never block the event loop: no sync fs/crypto in request paths, offload CPU work to `worker_threads` or a queue, stream large payloads (`pipeline()`).
- Measure before optimising: `node --cpu-prof`, `clinic doctor`, event-loop lag metrics (`perf_hooks.monitorEventLoopDelay`).
- Cache with explicit TTLs and invalidation; avoid unbounded in-memory caches (memory leaks).
- Memory: set `--max-old-space-size` relative to the container limit only when needed; watch heap in metrics.

## 6. Testing

- `node:test` or Vitest/Jest; Supertest for HTTP; Testcontainers for real DB integration tests.
- Contract tests for external APIs; no network calls in unit tests.
- Compact runs: `node --test --test-reporter=dot`, `npx vitest run --reporter=dot`.

## 7. Container image

Multi-stage, `npm ci --omit=dev`, non-root user, distroless or slim base pinned by digest, `NODE_ENV=production`, `HEALTHCHECK`/probes, no `.env` in the image (`container-supply-chain`).

## 8. Supply chain

- `npm ci` in CI; `npm audit --omit=dev --audit-level=high`; Dependabot/Renovate.
- Review `postinstall` scripts of new dependencies; consider `npm config set ignore-scripts true` for CI installs where the project allows it.
- Verify package names and publishers before adding; prefer packages with provenance (`npm view <pkg> --json | jq .dist.attestations`).

## Definition of done

Follow `code-fundamentals` and the gate in `javascript-typescript` (`prettier`, `eslint --max-warnings=0`, `tsc --noEmit`, tests with coverage). Backend additions:

- Unit tests for services and pure logic; Supertest tests for every route: success, validation failure (400), not found (404), unauthorised (401/403) and dependency failure (503/500 without internals).
- Async route errors reach the central handler (Express 5 forwards rejected promises; on Express 4 use a wrapper), never an unhandled rejection:

```ts
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DomainError) return res.status(err.status).json({ error: err.code });
  req.log.error({ err, reqId: req.id }, "unhandled error");
  res.status(500).json({ error: "internal_error", reqId: req.id });
});
```

## Never

- Use `exec`/`eval`/`vm` with untrusted input, or disable TLS checks (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
- Log request bodies, tokens or cookies; return stack traces to clients.
- Run as root in containers or keep processes alive after an uncaught exception.
- Publish packages or push images from an agent (guard asks; use CI).
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
