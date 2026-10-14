# Changelog

## 1.3.1 (2026-10-09)

- Skills are written for the agent, not for people: `ai-token-cost-control` and `ai-context-management` rewritten as agent behaviour (what to do on every task, what to suggest to the user when only they can act); `token-saver`, `cloud-mcp-setup`, guardrails and several cloud/db skills reworded to second person; "the human" → "the user" throughout.
- Installer instruction block (CLAUDE.md, AGENTS.md, Copilot, Gemini, Cursor, Windsurf) speaks to the agent: how to act on `check` exit codes, when to wrap commands with token-saver, definition of done.
- `write-company-skill` adds the rule "write for the agent"; `npm run validate` flags human-facing wording in skills.
- People-facing habits (fresh sessions, interrupting early, usage commands) moved to `docs/USAGE.md`.

## 1.3.0 (2026-10-09)

- New `code-fundamentals` skill (lang pack): definition of done (format, lint, type check, unit tests, coverage on changed code), unit tests for every new or changed function with logic (happy path, boundaries, invalid input, error path, regression), error-handling principles with try/catch patterns for 10 languages, readable-code fundamentals, quality-gate commands for JS/TS, Python, Java, Kotlin, Go, C#, Rust, PHP, Ruby, C/C++, shell and HTML/CSS.
- Every language skill now has a "Definition of done" section with its lint/test/coverage commands and an error-handling example, and loads `code-fundamentals`.
- `engineering-guardrails` and `/ask-skills` route code changes through the definition of done.

## 1.2.0 (2026-10-09)

- `report`: what the guard and token saver did, as text, Markdown, JSON or an HTML dashboard (`--days`, `--price`, `--dirs` across repos, `--scope user`). `scripts/demo-data.mjs` creates clearly marked sample data.
- cloud-guard writes per-check counters to `.cloud-guard/stats.jsonl` (decision, rule, tier, CLI; never the command text), rotated at 5 MB and gitignored.
- Docs: `docs/USAGE.md` (repo vs global setup with examples, calling skills in Claude Code, Codex, Copilot, Cursor, Gemini CLI, Windsurf; CLI; reports) and `docs/EXAMPLES.md` (with/without scenarios).
- README and site: usage, repo-or-global, with/without and report sections.

## 1.1.0 (2026-10-09)

- New packs: `git` (5), `lang` (9: secure-coding, HTML/CSS, JS/TS, Node.js, Python, Java/Spring, Go, .NET, shell), `db` (9: guardrails, SQL safety, migrations, PostgreSQL, MySQL, SQL Server, MongoDB, Redis, access control), `ai` (6: token cost control, token-saver, context management, LLM app cost control, prompt caching for Claude API/Bedrock/Azure OpenAI/Vertex, batch processing for Claude Message Batches/Bedrock/Azure OpenAI/Vertex).
- Core: `engineering-guardrails`, `write-company-skill`; router renamed `ask-cloud` → `ask-skills`.
- cloud-guard: 74 hard rules (git, databases, shell, package publishing, `.env` protection); database CLIs (psql, mysql, sqlcmd, sqlplus, mongosh, redis-cli, cqlsh) classified read/change/destructive with environment detection from hosts and URIs.
- token-saver: Claude Code PostToolUse hook and `run` wrapper that trims oversized command output, keeps errors, saves redacted full logs and reports savings.
- Installer: `--packs`, `--no-token-saver`, `saver` command; plugin `ai-cloud-skills-dev`.

## 1.0.0 (2026-10-09)

- 65 skills: 20 cross-cloud core, 15 AWS, 15 Azure, 15 Google Cloud.
- cloud-guard: hard rules, environment matrix, file and secret guard, audit log; adapters for Claude Code, Cursor and Gemini CLI hooks; `check`, `scan`, `explain` CLI.
- Installer for Claude Code, Codex, Cursor, Copilot, Gemini CLI, Windsurf and other Agent Skills tools; `doctor` and `uninstall`.
- Claude Code marketplace with `ai-cloud-skills` and per-cloud plugins.
- Integration site with live guard checker.
