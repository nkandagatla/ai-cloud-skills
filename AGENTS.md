# Working on this repository

This repo is the company skills library: agent skills for cloud, git, languages, databases and AI cost, the cloud-guard and token-saver hooks, and an installer. These instructions are for agents and humans changing the repo itself.

## Layout

- `skills/<group>/<name>/SKILL.md`, groups `core`, `aws`, `azure`, `gcp`, `git`, `lang`, `db`, `ai`. Folder name = frontmatter `name` (kebab-case, at most 64 chars).
- `guard/` holds the guard (`cloud-guard.mjs`, `rules.mjs`) and the output trimmer (`token-saver.mjs`). No dependencies, Node 18+ at runtime.
- `bin/cli.mjs` is the installer.
- Generated files (never edit by hand): `skills/*/*/agents/openai.yaml`, `skills/*/README.md`, `.claude-plugin/marketplace.json`, `site/catalog.json`, the catalog and guard bundle inside `site/index.html`, the skills tables in `README.md`. Run `npm run build`.

## Writing a skill

1. Frontmatter: `name`, `description` (what it covers + "Use when ..."; no `<` or `>`; at most 1024 chars). Add `disable-model-invocation: true` only for skills the user should trigger explicitly (setup, routers, reviews).
2. Open by loading the right guardrails skill: `cloud-guardrails` (cloud), `db-guardrails` (databases) or `engineering-guardrails` (everything else). `/write-company-skill` walks through the full template.
3. Structure for cloud skills: secure baseline (IaC snippet), read-only discovery commands, changes table with safety notes, troubleshooting table, `## Never`.
4. Commands in fenced blocks must be safe for an agent to run in nonprod, or be explicitly labelled as human/platform-team only. `scripts/validate.mjs` runs every fenced command through the guard.
5. Never include real account ids, subscription ids, emails, keys or tokens. Use `111122223333`, `acme-*`, `S`, `RG`, `P` placeholders.
6. Keep `SKILL.md` under 400 lines; move long reference material into sibling files and link them.
7. Verify facts against current provider docs: flags, API versions and service names change. When unsure, say "verify against your provider version" rather than guessing.

## Changing the guard

- Every new rule gets tests in `tests/guard.test.mjs` (a deny case and a nearby allow case).
- Rules match normalised, lower-cased, quote-stripped text. Anchor patterns on the CLI name (`${CLI}aws${SP}...`) so prose does not trigger them.
- Never weaken a rule without a security review; prefer adding `overrides` support for the user's policy.
- Fail safe: parsing problems lead to "ask", policy errors lead to "readonly".

## Before you open a PR

```bash
npm run check
claude plugin validate . --strict   # if Claude Code is installed
```
