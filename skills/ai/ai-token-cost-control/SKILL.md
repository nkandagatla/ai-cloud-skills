---
name: ai-token-cost-control
description: How an AI coding agent keeps its own token usage and cost low (Claude Code, Codex, Copilot, Cursor, Gemini CLI) - where tokens go, compact commands and targeted reads, model and effort choice, delegating noisy work to subagents, MCP and tool overhead, output trimming with token-saver, when to suggest clearing or compacting to the user, and how to configure team cost controls or prepare an AI spend review when asked. Use when a session is getting long or expensive, before running commands with large output, when choosing a model for a subagent, or when the user asks to reduce AI spend or set up AI budgets.
---

# AI Token Cost Control

Load `engineering-guardrails` first. Related: `ai-context-management` (what to keep in your context), `token-saver` (automatic output trimming), `llm-app-cost-control` (applications that call LLM APIs), `llm-prompt-caching` and `llm-batch-processing` (the two biggest API discounts).

## 1. Where your tokens go

Every turn re-sends the whole conversation: system prompt, tool definitions, project instructions (`CLAUDE.md`/`AGENTS.md`), loaded skills, every message, every tool call and **every tool result**. A large tool result is paid for again on every later turn of the session. Prompt caching makes re-sending cheaper, but cache misses (idle gaps, changed tools, compaction) re-process everything at full price. Output and thinking are billed at the higher output rate.

Your biggest levers, in order:

1. **Tool output volume**: what you choose to run and read.
2. **Session length**: unrelated work piled into one session.
3. **Model and effort** for subagents and delegated work.
4. **Always-loaded context**: instruction files, MCP servers, rules.
5. **Parallel agents**: each subagent carries its own context and bills separately.

## 2. What you do on every task

- **Search before reading**: `rg -n "symbol" src | head -50`, `git grep -n`, `git diff --stat`; open only the slice you need (`sed -n '120,180p' file`), never whole lockfiles, generated code, minified bundles, snapshots or data dumps.
- **Run commands in compact mode**: `pytest -q -x`, `npx vitest run --reporter=dot`, `./mvnw -B -q`, `go test ./pkg/... -run TestX`, `terraform plan -no-color | tail -60`, `kubectl get pods -o wide | head -40`, `--format json | jq` for the fields you need. Run one failing test, not the whole suite, while iterating.
- **Let token-saver work**: when output is trimmed, read the saved log with `rg`/`sed -n` for the part you need; do not re-run the command with `# no-compact` unless you really need every line.
- **Delegate noisy work** (full test runs, log digging, wide code searches, documentation lookups) to a subagent with a small, fast model where the tool supports it, and ask it to return a short summary: findings, `file:line`, next step.
- **Write tight answers**: report results and decisions, not the transcript of what you ran; don't echo large files or diffs back to the user.
- **Stop and ask** instead of looping: after two failed attempts at the same fix, summarise what you tried and ask the user, rather than spending many turns guessing.
- **Plan first for large changes** (plan mode where available) so a wrong direction is caught before you implement it.

## 3. When to suggest an action only the user can take

You cannot clear the session, change the model of the main session or interrupt yourself. Suggest it in one line when it helps:

| Signal | Suggest to the user |
| --- | --- |
| The new request is unrelated to the current work | "This is a new topic; starting a fresh session (`/clear`) keeps it cheaper. I've written the handoff note to `.agent-notes/<task>.md`." |
| The context is long but the task continues | "Compacting now would keep cost down: `/compact keep decisions, changed files, failing tests; drop logs`." |
| A routine task is running on a top-tier model or high effort | "A mid-tier model or lower effort is enough for this; switch with `/model` / `/effort` if you like." |
| The user pastes a very large log | Work from it, then mention that pointing to the file path next time is cheaper. |

Verify command names against the tool in use (Claude Code `/usage`, `/context`; Codex `/status`; Gemini CLI `/stats`); they change between versions.

## 4. When the user asks to set up team cost controls

Propose the changes as a PR (repo settings) or a written recommendation (org/admin settings), never apply admin or billing changes yourself:

- **Default model**: mid-tier for everyday coding; top-tier for architecture, hard debugging and large refactors; small models for subagents (`model: haiku` or equivalent in subagent definitions).
- **Lean instruction files**: `CLAUDE.md`/`AGENTS.md` under ~200 lines, procedures moved into skills, plus a "Compact instructions" section ("keep decisions, changed paths, failing test names; drop raw logs").
- **MCP**: only the servers the repo needs; prefer CLIs (`gh`, `aws`, `az`, `gcloud`), which add no per-tool definitions.
- **token-saver** hook enabled (default in this library); heavy paths ignored for search and read tools where supported (`node_modules`, `dist`, coverage, fixtures).
- **Budgets** (admin decisions, for the user to apply): `--max-budget-usd` for headless/CI runs (Claude Code), per-user or per-group spend limits, workspace rate limits that protect production API traffic, cloud budget alerts when models run on Bedrock, Vertex AI or Azure (`finops-preflight`).
- **Automation**: scheduled and CI agents get tight prompts, small models, budget caps and output limits; no idle loops re-sending large contexts.

## 5. When the user asks for an AI spend review

Gather numbers from the sources the user can give you (OpenTelemetry metrics, admin analytics exports, billing exports, `node .cloud-guard/bin/report.mjs --json` for token-saver savings) and fill this in:

```
Period: <week>   Active users: <n>   Spend: $<x> (vs budget $<y>)
Top patterns behind spend: long sessions / top-tier default / loops / large outputs
Cache hit rate and likely causes of misses (idle resumes, changing tool sets)
Model mix: % top-tier vs mid vs small
token-saver: ~<n> tokens saved; commands still producing large outputs → add compact flags to skills
Recommended actions: <config changes, budget changes, skill updates>
```

Report aggregates only: never include individual users' prompts, code or personal data.

## Never

- Read whole large files, lockfiles, logs or generated code into context when a search or slice answers the question.
- Run full, verbose test suites or builds repeatedly while iterating on one failure.
- Keep retrying the same failing approach over many turns instead of stopping to ask.
- Disable spend limits, raise budgets, buy capacity, or change billing, rate-limit or admin settings: these are decisions for the user's admins.
- Turn off cloud-guard, tests or security scans to save tokens.
- Send secrets or personal data to a model to "save a round trip".
