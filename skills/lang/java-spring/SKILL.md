---
name: java-spring
description: Company standard for Java and Spring Boot - LTS JDK, Maven/Gradle builds with wrappers and dependency management, project structure, Spring Boot configuration and profiles, Spring Security, validation, exception handling, JPA/Hibernate pitfalls (N+1, transactions), logging, Actuator hardening, testing with JUnit 5/Testcontainers, performance tuning and container images. Use when writing, reviewing or debugging Java or Spring Boot services and libraries.
---

# Java and Spring Boot

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first.

## 1. Baseline

- **LTS JDK** (21 or newer LTS as the org standardises); `java -version` to confirm; toolchains in the build file.
- Always use the wrapper: `./mvnw` / `./gradlew` (Windows: `mvnw.cmd`, `gradlew.bat`). Never rely on a globally installed Maven/Gradle version.
- Spring Boot on a supported version line; manage versions through the Boot BOM / `dependencyManagement` / version catalogs (`libs.versions.toml`), never ad-hoc versions per module.
- Code style: Google Java Format or Spotless; Checkstyle/PMD/SpotBugs (+ FindSecBugs) in CI; Error Prone where adopted.

Compact build commands (cheaper output for agents):

```bash
./mvnw -B -q -DskipTests verify            # compile + checks, quiet
./mvnw -B -q test -Dtest=OrderServiceTest  # one test class
./mvnw -B -q dependency:tree -Dincludes=com.fasterxml.jackson.core
./gradlew build --console=plain -q
./gradlew test --tests '*OrderServiceTest' --console=plain
```

## 2. Structure

- Package by feature (`com.acme.orders.refund`), not by layer only.
- Controllers thin → services (business rules, `@Transactional`) → repositories.
- DTOs (Java `record`s) at the API boundary; never expose JPA entities in responses (mass assignment, lazy-loading leaks).
- Immutability: `record`s, `final` fields, `List.copyOf`; avoid static mutable state.
- `Optional` for return values, not fields/parameters; no `null` returns from collections.

## 3. Configuration and secrets

- `application.yml` + profile files (`application-prod.yml`) without secrets; `@ConfigurationProperties` records with `@Validated`.
- Secrets from the secret manager: Spring Cloud AWS Secrets Manager / Parameter Store, Spring Cloud Azure Key Vault, Spring Cloud GCP Secret Manager, or env injected by the platform.
- Never log the `Environment` or `/actuator/env` output.

## 4. Spring Security baseline

```java
@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
  return http
    .authorizeHttpRequests(a -> a
        .requestMatchers("/actuator/health/**").permitAll()
        .anyRequest().authenticated())
    .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))   // validates iss/exp/signature
    .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
    .csrf(c -> c.disable())                                        // only for stateless token APIs
    .headers(h -> h.contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'")))
    .build();
}
```

- Method security (`@PreAuthorize`) for per-object authorization, plus ownership checks in services.
- Keep CSRF enabled for cookie/session-based apps.
- Bean Validation (`@Valid`, `@NotBlank`, `@Size`) on request DTOs; `@ControllerAdvice` maps exceptions to RFC 9457 `ProblemDetail` without stack traces.
- Actuator: expose only `health`, `info`, `prometheus` on a management port/network; never `env`, `heapdump`, `threaddump`, `loggers` publicly.
- Jackson: no default typing (`activateDefaultTyping`) with untrusted input; `FAIL_ON_UNKNOWN_PROPERTIES` deliberate.

## 5. JPA / Hibernate

- `@Transactional` on service methods (readOnly for queries); not on controllers; beware self-invocation (proxy) not applying transactions.
- Avoid N+1: fetch joins / `@EntityGraph`, DTO projections; enable `spring.jpa.open-in-view=false`.
- Log SQL only in dev (`logging.level.org.hibernate.SQL=debug`), never bind parameters in prod logs.
- Pagination for list endpoints (`Pageable` with max size).
- Optimistic locking (`@Version`) for concurrent updates.
- Schema changes through Flyway/Liquibase migrations (`db-migrations`); `spring.jpa.hibernate.ddl-auto=validate` (never `update`/`create` beyond local dev).
- Connection pool (HikariCP) sized from DB limits and instance count.

## 6. Logging and observability

SLF4J with parameterised messages (`log.info("refund {}", id)`), JSON logs (Logback encoder / ECS), MDC request/trace ids, Micrometer metrics, OpenTelemetry Java agent for traces. Never log tokens, passwords, full PANs or personal data.

## 7. Testing

- JUnit 5 + AssertJ + Mockito; `@WebMvcTest`/`@DataJpaTest` slices; **Testcontainers** for Postgres/MySQL/Kafka instead of H2 for DB behaviour.
- ArchUnit tests for layering rules where useful.
- Mutation testing (PIT) for critical domains.

## 8. Performance and runtime

- Virtual threads (`spring.threads.virtual.enabled=true` on supported versions) for blocking I/O-heavy services; avoid `synchronized` around blocking calls with virtual threads on older JDKs (pinning).
- Container-aware JVM: `-XX:MaxRAMPercentage=75`, no hard-coded `-Xmx` beyond the container limit; G1/ZGC per latency needs.
- Profile with JFR (`jcmd <pid> JFR.start`) before tuning; heap dumps contain data: treat as sensitive.

## 9. Supply chain and images

- `./mvnw org.owasp:dependency-check-maven:check` or Snyk/Trivy; Dependabot for Maven/Gradle.
- Reproducible builds; Jib or Buildpacks for images (non-root, distroless); SBOM via CycloneDX plugin.
- `mvn deploy` / `gradle publish` only from CI (guard asks).

## Definition of done

Follow `code-fundamentals`. For Java/Spring:

```bash
./mvnw -B -q spotless:check
./mvnw -B -q verify              # Checkstyle, PMD, SpotBugs+FindSecBugs, JUnit, JaCoCo check rule (80% lines/branches on new code)
./gradlew spotlessCheck check jacocoTestCoverageVerification --console=plain -q
```

- Every new or changed method with logic gets JUnit 5 tests (`@ParameterizedTest` for input tables), including the exception path: `assertThatThrownBy(() -> svc.refund(id)).isInstanceOf(RefundNotAllowed.class)`.
- Controllers get `@WebMvcTest` tests for 200/400/404/403; repositories get `@DataJpaTest` with Testcontainers.
- Errors: domain exceptions extend a base `DomainException`; translate them in one `@RestControllerAdvice` to `ProblemDetail`; wrap checked exceptions with the cause; `try-with-resources` for anything closeable; never `catch (Exception e) {}` or `e.printStackTrace()`.

```java
@RestControllerAdvice
class ApiErrors {
  @ExceptionHandler(OrderNotFound.class)
  ProblemDetail notFound(OrderNotFound e) { return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Order not found"); }

  @ExceptionHandler(Exception.class)
  ProblemDetail unexpected(Exception e) {
    log.error("Unhandled error", e);   // detail in logs, not in the response
    return ProblemDetail.forStatus(HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
```

## Never

- Expose JPA entities directly, use `ddl-auto=update` in shared environments, or log bind parameters in prod.
- Disable Spring Security, CSRF for session apps, or expose sensitive Actuator endpoints.
- Use Java native serialization or Jackson default typing on untrusted input.
- Hard-code credentials in `application*.yml` or tests.
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
