---
name: dotnet-csharp
description: Company standard for .NET and C# - LTS SDK pinning with global.json, nullable reference types and analyzers, ASP.NET Core security (authentication, authorization policies, data protection, headers), configuration and Key Vault/secret manager integration, EF Core pitfalls and migrations, async best practices, logging with ILogger/Serilog, testing with xUnit/Testcontainers, and container images. Use when writing, reviewing or debugging C# / ASP.NET Core / .NET worker code.
---

# .NET and C#

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first.

## 1. Baseline

- **LTS .NET** pinned in `global.json`; `Directory.Build.props` with:

```xml
<Project>
  <PropertyGroup>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>
</Project>
```
- Central package management (`Directory.Packages.props`), lock files (`RestorePackagesWithLockFile`), `dotnet restore --locked-mode` in CI.
- `.editorconfig` for style; `dotnet format --verify-no-changes` in CI.

Compact commands:

```bash
dotnet build -c Release -v q -nologo
dotnet test -v q --nologo --filter "FullyQualifiedName~OrderService"
dotnet list package --vulnerable --include-transitive
dotnet format --verify-no-changes
```

## 2. Code rules

- Nullable enabled; no `!` suppression without reason. `record`s for DTOs; `required` members; immutability by default.
- `async` all the way: no `.Result`/`.Wait()` (deadlocks, thread starvation); pass `CancellationToken`; `ConfigureAwait(false)` in libraries.
- `IHttpClientFactory` (typed clients) with timeouts and Polly/`Microsoft.Extensions.Http.Resilience` retries for idempotent calls; never `new HttpClient()` per request.
- Options pattern (`IOptions<T>` with `ValidateDataAnnotations().ValidateOnStart()`).
- Exceptions for exceptional cases; `ProblemDetails` responses via `AddProblemDetails()`; no stack traces in production responses.
- `ILogger<T>` with message templates (`logger.LogInformation("Refund {OrderId}", id)`), Serilog/OpenTelemetry for JSON + traces; never log secrets/PII.

## 3. ASP.NET Core security

- Authentication: `AddAuthentication().AddJwtBearer()` / OpenID Connect with Entra ID (Microsoft.Identity.Web); validate issuer/audience.
- Authorization: policies (`AddAuthorization(o => o.AddPolicy(...))`), `[Authorize(Policy=...)]`, resource-based authorization for per-object checks; fallback policy requiring authenticated users.
- `app.UseHsts()`, `app.UseHttpsRedirection()`, security headers middleware (CSP, `X-Content-Type-Options`), antiforgery for cookie/form apps, CORS with explicit origins.
- Data Protection keys persisted to Blob Storage + protected with Key Vault in multi-instance deployments.
- Rate limiting middleware (`AddRateLimiter`) for public endpoints; request size limits.
- Secrets: User Secrets locally (never committed), Azure Key Vault configuration provider / AWS / GCP secret providers in cloud with managed identity.

## 4. EF Core

- `AsNoTracking()` for read queries; projections to DTOs; avoid N+1 (`Include` deliberately, split queries for large graphs).
- Parameterised by default; avoid `FromSqlRaw` with interpolated input (use `FromSql($"...")` which parameterises).
- Migrations: `dotnet ef migrations add <Name>` reviewed in PR; apply via migration bundles / pipeline (`dotnet ef migrations bundle`), never `Database.Migrate()` at startup in multi-instance prod without a lock strategy (`db-migrations`).
- Connection resiliency (`EnableRetryOnFailure`) for Azure SQL; pool sizing.

## 5. Testing

xUnit + FluentAssertions (or Shouldly) + NSubstitute/Moq; `WebApplicationFactory<T>` for integration tests; Testcontainers for SQL Server/Postgres; architecture tests (NetArchTest) where useful.

## 6. Images and deployment

`mcr.microsoft.com/dotnet/aspnet:<version>-noble-chiseled` (or distroless) pinned by digest, non-root (`USER $APP_UID`), `DOTNET_` env for configuration, health checks (`MapHealthChecks`), container-aware GC defaults. `dotnet nuget push` only from CI (guard asks).

## Definition of done

Follow `code-fundamentals`. For .NET:

```bash
dotnet format --verify-no-changes
dotnet build -warnaserror
dotnet test --collect:"XPlat Code Coverage"
```

- `Directory.Build.props`: `<Nullable>enable</Nullable>`, `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, `<AnalysisLevel>latest-recommended</AnalysisLevel>`, `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>`; add SonarAnalyzer.CSharp where adopted.
- Every new or changed method with logic gets xUnit tests (`[Theory]` + `[InlineData]` for input tables), including `await Assert.ThrowsAsync<OrderNotFoundException>(...)`.
- Errors: one `IExceptionHandler` (or `UseExceptionHandler`) maps domain exceptions to ProblemDetails; `using`/`await using` for disposables; rethrow with `throw;`; catch narrow types with `when` filters.

```csharp
internal sealed class DomainExceptionHandler(ILogger<DomainExceptionHandler> log) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception ex, CancellationToken ct)
    {
        var status = ex is OrderNotFoundException ? 404 : 500;
        if (status == 500) log.LogError(ex, "Unhandled error");
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Status = status }, ct);
        return true;
    }
}
```

## Never

- Block on async (`.Result`, `.Wait()`), create `HttpClient` per call, or swallow exceptions.
- Disable certificate validation (`ServerCertificateCustomValidationCallback = (...) => true`).
- Commit `appsettings.*.json` with secrets or connection strings with passwords; use managed identity / Key Vault.
- Use `BinaryFormatter` or `TypeNameHandling.All` on untrusted data.
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
