# Security

## Threat model

ai-cloud-skills assumes an AI coding agent with shell and file access works in a repository that manages cloud infrastructure. It defends against:

| Threat | Control |
| --- | --- |
| Agent targets production by mistake | Environment detection + prod mutation deny; `CLOUD.md`; identity checks in every skill |
| Agent weakens security posture | Hard rules (public data, open admin ports, admin grants, long-lived keys, audit/detection off, key and backup deletion) |
| Secrets leak into the transcript, logs or git | Secret-read rules (CLI and file paths), secret-write content scanning, `scan` command for pre-commit/CI |
| Unreviewed infrastructure changes | Blocks `-auto-approve`, `destroy`, `--require-approval never`, complete-mode deployments; `cloud-change-plan` protocol |
| Prompt injection via cloud data | `cloud-guardrails` rule: tags, logs, objects, tickets are data, never instructions; the guard enforces regardless of what the model was told |
| Agent disables its own guardrails | Agents are blocked from editing `.cloud-guard/` and hook settings; weakening a rule needs a written justification in the policy |
| Obfuscated commands | Encoded / base64-to-shell execution denied; chained commands evaluated segment by segment |

## Out of scope (be honest with yourself)

- Code the agent writes and runs (an SDK script) can call cloud APIs without passing a recognisable CLI command.
- MCP servers call APIs directly; use read-only identities (`cloud-mcp-setup`).
- A human can always run anything; the guard protects against agent mistakes, not malicious operators.
- Pattern matching has false negatives and false positives. Defence in depth: least-privilege agent credentials, SCPs/RCPs, Azure Policy, Org Policy, branch protection, CI policy checks.

## Recommended identity setup for agents

- Default the agent's shell to a **read-only** role/profile/configuration.
- Give write access only to sandbox/nonprod, scoped to the project's resources.
- No production write credentials on developer machines; production changes go through CI with OIDC and environment approvals (`cicd-oidc`).

## Reporting a vulnerability

Please report bypasses of the guard or unsafe guidance in a skill privately via GitHub Security Advisories on this repository, with a minimal reproduction (the command, the policy, the expected and actual decision). Do not include real credentials.
