---
name: go
description: Company standard for Go - modules and toolchain pinning, project layout, error handling and wrapping, context propagation and timeouts, concurrency patterns and race detection, net/http server hardening, database/sql usage, structured logging with slog, testing (table tests, fuzzing), linting with golangci-lint, govulncheck and static binaries in distroless images. Use when writing, reviewing or debugging Go services, CLIs or operators.
---

# Go

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first.

## 1. Baseline

- `go.mod` with `go` and `toolchain` directives pinned; supported Go release only. Commit `go.sum`. `go mod tidy` in PRs that change deps.
- Layout: `cmd/<app>/main.go`, `internal/...` for non-exported packages, `pkg/` only for truly reusable libraries. Small packages named by what they provide.
- Lint: `golangci-lint run` with `govet`, `staticcheck`, `errcheck`, `gosec`, `revive`, `bodyclose`, `contextcheck`, `errorlint`.
- `gofmt`/`goimports` always.

## 2. Code rules

- Errors are values: check every error; wrap with context `fmt.Errorf("load order %s: %w", id, err)`; compare with `errors.Is/As`; no `panic` for expected failures.
- `context.Context` is the first parameter of anything doing I/O; respect cancellation; set timeouts at the edge (`context.WithTimeout`).
- Concurrency: goroutines have an owner and a way to stop (context, `errgroup`); bounded worker pools; channels closed by the sender; protect shared state with `sync.Mutex` or confine it. Run tests with `-race`.
- No global mutable state; dependency injection via constructors.
- Interfaces defined where they are consumed, small.
- `slog` for structured logs; never log secrets/PII.
- Money with integer minor units or a decimal package; time in UTC (`time.Now().UTC()`).

## 3. HTTP server hardening

```go
srv := &http.Server{
    Addr:              ":8080",
    Handler:           mux,
    ReadHeaderTimeout: 5 * time.Second,
    ReadTimeout:       15 * time.Second,
    WriteTimeout:      15 * time.Second,
    IdleTimeout:       60 * time.Second,
    MaxHeaderBytes:    1 << 20,
}
// body limits per handler: r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
```

- Graceful shutdown with `srv.Shutdown(ctx)` on SIGTERM.
- Outbound `http.Client` with `Timeout`; never `InsecureSkipVerify: true`.
- Validate input (struct tags with `go-playground/validator` or explicit checks); `html/template` (auto-escaping) never `text/template` for HTML.
- `os/exec` with explicit args, no shell.

## 4. Data access

`database/sql` (or `pgx`) with `QueryContext` + placeholders; set `SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime`; always `rows.Close()` and check `rows.Err()`; transactions with deferred rollback. Migrations with `golang-migrate`/`goose`/Atlas (`db-migrations`).

## 5. Testing

```bash
go test ./... -race -count=1 -shuffle=on
go test ./internal/orders -run TestRefund -v
go test -fuzz=FuzzParse -fuzztime=30s ./internal/parse
go vet ./... && golangci-lint run
govulncheck ./...
```

Table-driven tests with `t.Run`, `t.Parallel()` where safe, `httptest` for handlers, Testcontainers-go for databases. Compact output: omit `-v` unless debugging one test; large outputs are trimmed by `token-saver`.

## 6. Build and image

`CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$VERSION"`, distroless static image, non-root, read-only filesystem (`container-supply-chain`).

## Definition of done

Follow `code-fundamentals`. For Go:

```bash
test -z "$(gofmt -l .)" && go vet ./... && golangci-lint run
go test ./... -race -count=1 -coverprofile=cover.out && go tool cover -func=cover.out | tail -1
```

- golangci-lint with at least `errcheck`, `govet`, `staticcheck`, `gosec`, `errorlint`, `gocyclo`, `revive`.
- Every new or changed function with logic gets a table-driven test with error cases (`wantErr` + `errors.Is`).
- Every `err` is handled or returned with context (`%w`); `defer` closes resources right after they are opened.

## Never

- Ignore errors (`_ = f()` without reason), `panic` in libraries, or leak goroutines.
- `InsecureSkipVerify`, `text/template` for HTML, string-built SQL.
- Unbounded goroutine fan-out or unbounded reads (`io.ReadAll` on untrusted bodies without limits).
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
