---
name: code-fundamentals
description: Company coding fundamentals for every language - the definition of done (format, lint, type-check, unit tests, coverage), unit tests for every function or branch with logic, error handling (try/catch at boundaries, never swallow, wrap with context, always clean up), input validation, naming, small functions, logging, and quality-gate commands for JavaScript/TypeScript, Python, Java, Kotlin, Go, C#, Rust, PHP, Ruby, C/C++, shell and HTML/CSS. Use when writing, changing or reviewing any code, in any language, before saying a change is done.
---

# Code Fundamentals

Load `engineering-guardrails` and `secure-coding` first. The language skill (`python`, `java-spring`, `javascript-typescript`, `nodejs-backend`, `go`, `dotnet-csharp`, `shell-scripting`, `html-css`) adds the language detail; this is the common standard every change meets.

## 1. Definition of done

A code change is done only when all of these pass locally, in this order, and you report what you ran:

1. **Format**: the project's formatter, no manual style changes.
2. **Lint**: zero new warnings. Fix the code; do not add disable comments unless a reviewer agrees and the comment says why.
3. **Type check** where the language has one (TypeScript, mypy/pyright, compiler warnings as errors).
4. **Unit tests** for every new or changed function that contains logic (section 2), and the existing suite still green.
5. **Coverage** on changed lines at or above the repo threshold (default **80 % lines on changed code**; critical domains such as payments, auth and money 90 %+ with branch coverage).
6. **Security checks** the repo runs (dependency audit, SAST, secret scan).

If a tool is missing in the repo, propose adding it (section 7) in a separate PR instead of skipping the step. Never mark tests as skipped, delete failing tests or lower a threshold to get green.

## 2. Unit tests for every function with logic

**What must have tests**: every new or changed function, method or component that has a branch, loop, calculation, parsing, validation, mapping, error path or state change. Pure pass-through code (plain getters, DTOs, wiring) does not need its own test; it is covered by the caller's test.

**What each test set covers** (one function, several small tests):

| Case | Example for `applyDiscount(total, code)` |
| --- | --- |
| Happy path | valid code reduces the total |
| Boundaries | total 0, minimum order exactly at the limit, maximum discount cap |
| Invalid input | unknown code, negative total, `null`/`None`/empty |
| Error path | the pricing lookup throws: function raises the documented error, nothing half-written |
| Regression | the bug you are fixing, as a test that failed before the fix |

**How tests are written**:

- Arrange, act, assert; one behaviour per test; names that read as a sentence (`rejects_expired_code`, `"returns 0 when cart is empty"`).
- Deterministic: no real clock, randomness, network or shared state. Inject the clock and IDs; fake HTTP at the boundary; use Testcontainers for real database behaviour in integration tests.
- Test behaviour through the public interface, not private helpers or mock call counts.
- Fast: unit tests run in milliseconds; slow tests are marked integration and run separately.
- Test the error paths as carefully as the happy path: assert the error type and message, and that cleanup happened.
- Table-driven / parametrised tests for many input cases (`pytest.mark.parametrize`, `it.each`, JUnit `@ParameterizedTest`, Go tables, xUnit `[Theory]`).
- Bug fix: write the failing test first, then fix.

Pyramid: many unit tests, fewer integration tests (real database, real HTTP within the service), a few end-to-end tests for critical journeys.

## 3. Error handling

Principles, in every language:

1. **Catch where you can act**: at a boundary (HTTP handler, message consumer, CLI entry point, job runner) or where you can genuinely recover (retry, fallback, default). Elsewhere, let errors propagate.
2. **Never swallow**: no empty `catch`, no `except: pass`, no ignored Go `err`, no `|| true` in scripts. If you really mean to ignore one, comment why and log at debug.
3. **Wrap with context, keep the cause**: what you were doing and with which id, plus the original error (`cause`, `from exc`, `%w`, inner exception).
4. **Specific types**: catch the narrowest error type; define domain errors (`OrderNotFound`, `PaymentDeclined`) for expected failures. Don't use exceptions for normal control flow.
5. **Always clean up**: `finally`, `with`, `using`, `try-with-resources`, `defer`, `trap`. Connections, files, locks and temp files close on every path.
6. **Fail fast on bad input and config**: validate at the start; crash at startup on missing config rather than failing at the first request.
7. **Retries only for transient errors on idempotent operations**, with timeouts, exponential backoff, jitter and a cap. Never retry a non-idempotent payment or write without an idempotency key.
8. **Users get a safe message, logs get the detail**: no stack traces, SQL or internal hosts in API responses; log once, at the boundary, with a request/trace id (not at every layer).
9. **Every external call has a timeout.**

| Language | Pattern |
| --- | --- |
| TypeScript / JS | `try { await charge(o) } catch (err) { throw new PaymentError(\`charge ${o.id}\`, { cause: err }) }`; no floating promises; `finally` for cleanup |
| Python | `try: ... except httpx.TimeoutException as exc: raise PaymentError(f"charge {order_id}") from exc`; `with` for resources; never bare `except:` |
| Java / Kotlin | `try (var conn = ds.getConnection()) { ... } catch (SQLException e) { throw new OrderStoreException("load " + id, e); }`; `@ControllerAdvice` / `ProblemDetail` at the edge; never catch `Throwable` |
| Go | `if err != nil { return fmt.Errorf("load order %s: %w", id, err) }`; `defer rows.Close()`; `errors.Is/As`; panic only for programmer errors |
| C# | `using var conn = ...;` `catch (SqlException ex) when (ex.Number == 1205) { ... }`; `throw;` (not `throw ex;`) to rethrow; ProblemDetails at the edge |
| Rust | `Result<T, E>` with `?`; `thiserror` for library errors, `anyhow::Context` in apps; no `unwrap()`/`expect()` outside tests and proven invariants |
| PHP | typed exceptions, `try/catch/finally`, `previous:` argument to keep the cause; never `@` error suppression |
| Ruby | `rescue SpecificError => e` then `raise OrderError, "load #{id}"` (cause is kept); `ensure` for cleanup; never bare `rescue` |
| C / C++ | check every return code; RAII (`std::unique_ptr`, scoped locks) in C++; `goto cleanup` pattern in C; exceptions only where the codebase uses them |
| Shell | `set -Eeuo pipefail`, `trap cleanup EXIT`, check commands you expect to fail explicitly (`if ! cmd; then ...`) |

## 4. Fundamentals of readable, maintainable code

- **Names** say what, not how: `unpaidInvoices`, not `list2`; functions are verbs (`calculateRefund`); booleans read as questions (`isExpired`). No unexplained abbreviations.
- **Small functions, one job**: if a function needs "and" to describe it, split it. Aim for under ~40 lines and cyclomatic complexity under ~10 (the linter enforces it).
- **Guard clauses** instead of deep nesting: return early on invalid cases.
- **Pure logic separated from I/O**: calculations and decisions in pure functions (easy to unit test); database, HTTP, clock and filesystem at the edges, injected.
- **Immutability by default**: `const`, `final`, `readonly`, records/dataclasses(frozen); do not mutate inputs.
- **No magic numbers or strings**: named constants or enums.
- **DRY with judgement**: remove real duplication of rules; don't build abstractions for one caller ("rule of three").
- **Validate at boundaries** (schemas: zod, pydantic, Bean Validation, FluentValidation); trust typed data inside.
- **Money** in integer minor units or decimal types; **time** in UTC with timezone-aware types; **IDs** as opaque strings/UUIDs.
- **Logging**: structured, levelled (`debug` detail, `info` business events, `warn` recoverable, `error` needs action), with correlation ids; never secrets or personal data.
- **Comments explain why**, not what. Public functions get a doc comment stating inputs, outputs and errors thrown.
- **Dead code** is deleted, not commented out; git keeps history.
- **Dependencies**: prefer the standard library; new dependencies need a reason (licence, maintenance, size, security).
- **Configuration** from environment/config files validated at startup; no hard-coded URLs, credentials or environment names.
- **Concurrency**: every background task has an owner, a timeout and a way to stop; shared state is protected or avoided.

## 5. Quality gate commands by language

Use the project's existing scripts first (`npm run lint`, `make check`, `./gradlew check`). Otherwise:

| Language | Format | Lint / static analysis | Types | Unit tests + coverage |
| --- | --- | --- | --- | --- |
| TypeScript / JS | `npx prettier --check .` | `npx eslint . --max-warnings=0` | `npx tsc --noEmit` | `npx vitest run --coverage` or `npx jest --coverage` |
| Python | `ruff format --check .` | `ruff check .` (+ `bandit -q -r src`) | `mypy src` or `pyright` | `pytest -q --cov=src --cov-fail-under=80` |
| Java (Maven) | `./mvnw -B -q spotless:check` | Checkstyle, PMD, SpotBugs + FindSecBugs, Error Prone in `verify` | compiler `-Werror` | `./mvnw -B -q verify` (JUnit 5 + JaCoCo `check` rule) |
| Java / Kotlin (Gradle) | `./gradlew spotlessCheck` | `./gradlew check` (Checkstyle/PMD/SpotBugs, detekt + ktlint for Kotlin) | compiler `allWarningsAsErrors` | `./gradlew test jacocoTestCoverageVerification` (Kover for Kotlin) |
| Go | `gofmt -l .` (empty output) | `go vet ./... && golangci-lint run` | compiler | `go test ./... -race -cover` |
| C# / .NET | `dotnet format --verify-no-changes` | Roslyn analyzers, `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, `AnalysisLevel` latest-recommended | nullable enabled | `dotnet test --collect:"XPlat Code Coverage"` |
| Rust | `cargo fmt --check` | `cargo clippy --all-targets -- -D warnings` | compiler | `cargo test` (+ `cargo llvm-cov`) |
| PHP | `vendor/bin/php-cs-fixer fix --dry-run` | `vendor/bin/phpstan analyse` (level 8+) or Psalm | `declare(strict_types=1)` | `vendor/bin/phpunit --coverage-text` |
| Ruby | `bundle exec rubocop` | `bundle exec rubocop` (+ `brakeman` for Rails) | Sorbet/RBS where adopted | `bundle exec rspec` (SimpleCov) |
| C / C++ | `clang-format --dry-run --Werror` | `clang-tidy`, `cppcheck`, `-Wall -Wextra -Werror` | compiler | GoogleTest/Catch2 via `ctest`, sanitizers (`-fsanitize=address,undefined`) in CI |
| Shell | `shfmt -d .` | `shellcheck` | n/a | `bats test/` |
| HTML / CSS | `npx prettier --check .` | `npx stylelint "**/*.css"`, `npx html-validate` | n/a | axe/Playwright checks (`html-css`) |

Keep output compact for agents (`-q`, `--reporter=dot`); the `token-saver` hook trims the rest.

## 6. Self-review before you finish (and when asked to review a PR)

- Does every new branch have a test, including the error branch?
- Can any error be silently lost? Is every resource closed on every path?
- Is input validated at the boundary, and output encoded at the sink (`secure-coding`)?
- Is the function small enough to understand in one read? Are names honest?
- Are external calls bounded (timeout, retry policy, idempotency)?
- Does the PR description list the commands run and their result (`git-commits-prs`)?

## 7. Adding the gate to a repo that lacks it

1. Add formatter and linter config with the company defaults; fix existing violations in a **separate formatting-only PR** so reviews stay readable.
2. Add a `check` script (`npm run check`, `make check`, `./gradlew check`) that runs format → lint → types → tests.
3. Add the same command to CI on every PR, plus `pre-commit` hooks (`templates/pre-commit-config.yaml`).
4. Turn on the coverage threshold for changed code (diff coverage) first; raise the global threshold gradually.

## Never

- Never say a change is done without running format, lint, type check and the relevant tests, and saying which ones ran.
- Never add logic without a unit test that would fail if the logic broke.
- Never delete, skip or weaken a failing test, lower a coverage threshold or add a lint-disable comment just to get green.
- Never swallow an error (empty catch, bare `except: pass`, ignored `err`, `|| true`).
- Never return stack traces, SQL or internal details to users; never log secrets or personal data.
- Never call an external service without a timeout, or retry a non-idempotent write without an idempotency key.
