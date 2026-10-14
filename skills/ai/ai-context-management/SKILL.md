---
name: ai-context-management
description: How an AI agent keeps its own context window small and useful without losing important history - loading files and logs just in time, reading surgically, delegating noisy work to subagents, keeping a handoff note, suggesting clear or compact to the user at the right moment, resuming work across sessions, and writing lean CLAUDE.md/AGENTS.md files with progressive disclosure. Use when a session gets long, before switching tasks, when context is nearly full, when resuming earlier work, or when asked to create or trim project instruction files.
---

# AI Context Management

Load `engineering-guardrails` first. Goal: you always hold the context the task needs (decisions, constraints, current state) and none of the noise (old logs, dead ends, whole files you already summarised).

## 1. Load just in time

- Start from the task: identify the files, functions, tickets and acceptance criteria before exploring. If the request is vague ("improve the codebase"), ask one question to narrow it instead of scanning everything.
- Search before reading: `rg -n "symbol" src/ | head`, `git grep -n`, code intelligence (go to definition) instead of opening whole files.
- Read slices: specific line ranges, one function, `sed -n '120,180p' file`. Skip lockfiles, generated code, minified bundles, snapshots, large fixtures and binary files.
- When `token-saver` trims an output, read the saved log selectively (`rg -n "FAIL|Error" <log>`).
- Load skills when the task needs them; don't open every skill "just in case".

## 2. Delegate noisy work

Use a subagent (where the tool supports it) for: running and triaging a full test suite, reading long logs, researching documentation, scanning many files for a pattern. Give it a focused prompt and ask for a short structured result (findings, `file:line`, next step). The noise stays in its context, not yours. Choose a smaller model for these helpers when you can.

## 3. Keep a running handoff note

For multi-step tasks, maintain a small file (for example `.agent-notes/<task>.md`, gitignored, or the PR description):

```markdown
# Task: PAY-142 refund endpoint
Goal / acceptance: ...
Decisions: (1) validate refund <= captured amount in service layer; (2) reuse ProblemDetails errors
Done: endpoint + service + 6 tests (src/refunds/*)
Open: idempotency key handling; docs
Gotchas: payments-sandbox needs VPN; tests use Testcontainers Postgres 16
```

Update it at each milestone and before any point where context may be lost. It survives clearing, compaction, new sessions and handoffs to other agents or people. Never put secrets or personal data in it.

When resuming work, read the handoff note (and `git log`/`git status`) first instead of asking the user to repeat context.

## 4. Clear, compact or continue

You cannot clear or compact the session yourself; suggest it to the user in one line when the signal appears, after updating the handoff note:

| Signal | Suggest |
| --- | --- |
| The new request is unrelated to the current work | Start a fresh session (`/clear` or a new chat); stale context costs on every turn |
| Same task, context long, earlier details still matter | Compact with what to keep, e.g. `/compact keep decisions, changed file paths, failing test names, open questions; drop logs and file dumps` |
| Coming back after a long break on a big session | A fresh session started from the handoff note |
| You are repeating a mistake or losing track | Say so, summarise what you tried, and suggest rewinding to a checkpoint or a fresh session with the handoff note |

Command names differ by tool and version; use the ones the current tool supports.

## 5. Writing project instruction files

`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.github/copilot-instructions.md` load into **every** session. When asked to create or update one, keep it under ~200 lines:

- What the project is (2-3 lines), exact build/test/lint commands with compact flags, a directory map, key conventions, what not to touch, where docs and runbooks live.
- A "Compact instructions" section: what must survive summarisation (decisions, changed paths, failing tests, open questions).
- Point to skills for procedures (migrations, releases, incident response, cloud work) instead of copying them in.
- Remove stale or duplicated lines: every line costs tokens in every session.

## 6. Multi-agent and parallel work

- Each subagent has its own context and bills separately: give it a focused prompt and let it finish; don't spawn agents for trivial lookups.
- Use git worktrees for parallel agents on separate branches (`git-workflow`) and merge through PRs.
- Share state through files (handoff notes, PR descriptions, tickets), not by copying transcripts between agents.

## Never

- Load entire logs, data dumps or large files into context when a path and a search will do.
- Continue piling unrelated tasks into one long session without suggesting a fresh one.
- Put secrets, tokens or personal data into handoff notes, compaction instructions or prompts.
