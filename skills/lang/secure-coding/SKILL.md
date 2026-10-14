---
name: secure-coding
description: Language-agnostic secure coding standard for agents - OWASP Top 10 and API Top 10 defences, input validation, output encoding, injection (SQL/NoSQL/command/LDAP), authn/authz checks, secrets handling, crypto do's and don'ts, SSRF, deserialization, file uploads, logging without PII, dependency risk, and a review checklist. Use when writing or reviewing any code that handles input, auth, data, files, URLs or secrets, in any language.
---

# Secure Coding

Load `engineering-guardrails` first. Language skills (`code-fundamentals` for lint, tests and error handling; `javascript-typescript`, `nodejs-backend`, `python`, `java-spring`, `go`, `dotnet-csharp`, `html-css`, `shell-scripting`) add language-specific detail; this is the common baseline.

## 1. Trust boundaries

Everything from outside the process is untrusted: HTTP params/headers/bodies/cookies, files, queue messages, webhooks, environment of other services, database content written by users, LLM output. Validate at the boundary, encode at the sink.

## 2. Defences by vulnerability class

| Class | Do | Don't |
| --- | --- | --- |
| **SQL injection** | Parameterised queries / prepared statements / ORM bindings; allow-list identifiers (sort columns) | String-concatenate SQL; escape by hand |
| **NoSQL injection** | Validate types (reject objects where strings expected, e.g. `{"$ne": null}`); use driver query builders | Pass raw JSON from requests into queries |
| **Command injection** | Avoid shells; call executables with argument arrays (`execFile`, `subprocess.run([...])`, `ProcessBuilder(list)`); allow-list arguments | `exec(string)`, `shell=True`, `Runtime.exec(String)` with input |
| **XSS** | Context-aware output encoding (template auto-escaping), CSP, `textContent` over `innerHTML`, sanitize rich HTML with DOMPurify / OWASP Java HTML Sanitizer / bleach | Disable auto-escaping, build HTML strings from input |
| **Broken access control** | Check authorization on **every** request server-side, per object (`order.ownerId === user.id`), deny by default, central policy | Trust IDs from the client, hide buttons instead of enforcing |
| **Auth** | Proven frameworks (OIDC, Spring Security, Passport, ASP.NET Identity); MFA for admins; rate-limit login; secure session cookies (`HttpOnly; Secure; SameSite`) | Roll your own auth/crypto, store passwords reversibly |
| **Passwords** | Argon2id (or bcrypt cost ≥ 12, scrypt) with per-user salt via library | MD5/SHA-x for passwords, custom salting |
| **Crypto** | Platform libraries; AES-GCM / ChaCha20-Poly1305; keys from KMS/Key Vault/Cloud KMS; CSPRNG (`crypto.randomBytes`, `secrets`, `SecureRandom`) | ECB mode, static IVs, `Math.random()` for tokens, hard-coded keys |
| **SSRF** | Allow-list destination hosts; block private/link-local ranges incl. `169.254.169.254`; resolve then check IP; disable redirects or re-check | Fetch arbitrary user-supplied URLs from servers |
| **Deserialization** | JSON with schema validation; safe YAML loaders (`yaml.safe_load`); Jackson without default typing | `pickle`/Java native serialization/`BinaryFormatter` on untrusted data |
| **Path traversal** | Resolve and verify the canonical path stays under the base dir; generate server-side filenames | Join user input into paths |
| **File upload** | Size limits, type check by content (magic bytes), store outside web root / in object storage with random names, malware scan, serve with `Content-Disposition: attachment` | Trust extension or `Content-Type` |
| **XXE** | Disable DTDs/external entities in XML parsers | Default parser settings in older stacks |
| **CSRF** | Framework CSRF tokens or SameSite cookies + origin checks for cookie-authenticated state changes | Disable CSRF protection "to make the form work" |
| **Open redirect** | Allow-list redirect targets or relative paths only | Redirect to `?next=` verbatim |
| **Mass assignment** | Explicit DTOs / allow-listed fields | Bind request bodies straight onto entities |
| **Rate limiting / DoS** | Limits per user/IP, request size limits, timeouts on every outbound call, pagination caps | Unbounded queries, regex on untrusted input without limits (ReDoS) |
| **CORS** | Specific origins; never `*` with credentials | Reflect any `Origin` |

## 3. Secrets and configuration

- Read secrets from the environment / secret manager at runtime; never commit them, log them, or include them in error messages.
- Separate config per environment; fail closed if required config is missing.
- Feature flags and debug endpoints off in production; no stack traces to clients.

## 4. Logging and privacy

- Structured logs with request ids; log security events (login, permission denied, admin actions).
- Never log passwords, tokens, full card numbers, secrets, session ids, or full personal data; mask (`****1234`).
- Do not put personal data in URLs (they end up in logs).

## 5. LLM-specific (apps that call models)

- Treat model output as untrusted input: validate/parse against a schema, never `eval`/execute it, encode before rendering.
- Prompt injection: keep untrusted content separate from instructions, least-privilege tools, human confirmation for side effects (`genai-platforms`).
- Do not send secrets or unnecessary personal data in prompts.

## 6. Dependencies

Pin via lockfiles, scan (`npm audit`, `pip-audit`, `mvn org.owasp:dependency-check-maven:check`, `govulncheck`, `dotnet list package --vulnerable`), keep updated (Dependabot/Renovate), prefer maintained packages, verify names before adding.

## 7. Review checklist

- [ ] All inputs validated (type, length, range, format) at the boundary
- [ ] Every data access is authorised for the current user
- [ ] Queries parameterised; no shell/eval with input
- [ ] Output encoded for its context; CSP for web UIs
- [ ] Secrets from secret manager; none in code, logs, errors, tests
- [ ] Outbound calls have timeouts; URLs allow-listed
- [ ] Errors do not leak internals; security events logged without PII
- [ ] New dependencies justified, pinned, scanned
- [ ] Tests include negative/abuse cases (unauthorised access, malicious input)

## Never

- Disable security features (TLS verification, CSRF, auth middleware, escaping, certificate pinning) to fix an error.
- Write your own cryptography, password hashing or session handling.
- Put credentials, tokens or personal data in code, tests, fixtures, logs or prompts.
- Mark a security finding as fixed without a test that would fail if it regressed.
