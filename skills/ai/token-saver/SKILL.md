---
name: token-saver
description: How to work with the token-saver that ships with this library - a Claude Code PostToolUse hook and a run wrapper that trims large command output (test runs, builds, installs, logs) before the model sees it, keeps errors and summaries, saves the full redacted output to a local log for follow-up reads, and reports savings. Use when you are about to run a command with large output, when an output was trimmed and you need the omitted part, when the user asks to tune output trimming, or when comparing with third-party tools such as RTK.
---

# Token Saver

Load `engineering-guardrails` first. token-saver lives at `.cloud-guard/bin/token-saver.mjs` (installed with the guard; no third-party binaries, no network, no telemetry).

## 1. How it works (and why history is not affected)

- **Claude Code**: a `PostToolUse` hook on `Bash`. The command runs **exactly as written**, so cloud-guard, the user's permission rules and approvals see the real command. After it finishes, if the output is larger than the threshold, the hook replaces the tool result with a compacted version:
  - strips ANSI codes, progress bars, download/“already satisfied” noise and passing-test lines;
  - collapses repeated lines (`[x3000]`);
  - keeps the first and last lines (summaries live at the end), plus every error/warning/failure/stack-trace line from the middle, with line numbers;
  - appends `[token-saver] … Full output (secrets redacted): .cloud-guard/token-saver/logs/<file>.log`.
- **Conversation history is untouched**: nothing earlier in the session is rewritten or summarised. Only this one oversized tool result is shortened, and the full version is one `Read`/`rg` away. Compare this with compaction, which summarises the whole conversation.
- **Other agents** (Codex, Copilot, Cursor, Gemini, Windsurf): there is no output-rewriting hook, so wrap commands that may produce large output yourself:

```bash
node .cloud-guard/bin/token-saver.mjs run -- npm test
node .cloud-guard/bin/token-saver.mjs run -- ./mvnw -B test
node .cloud-guard/bin/token-saver.mjs run -- kubectl logs deploy/api --since=30m
```

It runs the command, prints compacted output, saves the full log, and exits with the command's exit code. cloud-guard still evaluates the wrapped command.

## 2. When you need the omitted part

1. Read the saved log narrowly: `rg -n "FAIL|Error" .cloud-guard/token-saver/logs/<file>.log | head -50`, or open a range of lines.
2. Or re-run a narrower command (`pytest tests/test_refund.py -x -q`, `--tests 'OrderServiceTest'`, `kubectl logs ... | rg ERROR`).
3. To skip trimming for one command, append the marker comment: `npm run build # no-compact`.

Saved logs have secrets redacted with the guard's secret patterns, are gitignored, and are pruned to the newest 50 by default.

## 3. Configuration (the user owns `.cloud-guard/policy.json`)

You cannot edit `.cloud-guard/` (guard-blocked). When the user asks to tune trimming, propose the change below for them to apply:

```json
{
  "tokenSaver": {
    "enabled": true,
    "maxChars": 6000,
    "headLines": 30,
    "tailLines": 50,
    "maxSignalLines": 80,
    "verbatim": ["cat", "head", "tail", "sed", "jq", "git diff", "git show", "diff"],
    "verbatimMaxChars": 40000,
    "keepLogs": 50,
    "stats": true
  }
}
```

- `verbatim` commands are ones where you asked for exact content (reading a file, a diff). They are only trimmed above `verbatimMaxChars`, so normal file reads are never altered.
- Suggest raising `maxChars` if you keep needing the saved log for this repo's outputs; lowering it saves more.
- `enabled: false` turns it off without uninstalling.

## 4. Measure

```bash
node .cloud-guard/bin/token-saver.mjs gain
# token-saver: 214 outputs compacted, ~1,284,000 tokens saved (91% of ~1,410,000).
# Top commands:  npm test 61x ~402,000 tokens ...
```

(Estimate: characters ÷ 4.) Use it when the user asks for an AI spend review (`ai-token-cost-control`). For commands that keep appearing at the top, use compact flags yourself and suggest adding them to the relevant skill (`--reporter=dot`, `-q`, `--stat`).

## 5. Use compact flags first (no tooling needed)

| Tool | Compact form |
| --- | --- |
| git | `git status -sb`, `git log --oneline -20`, `git diff --stat`, `git show --stat <sha>` |
| npm/pnpm | `npm ci --no-audit --no-fund --loglevel=error`, `npm ls --depth=0` |
| Jest / Vitest / Playwright | `--silent`, `--reporter=dot`, `--reporter=line`, `-t "<name>"` |
| pytest | `-q -x --no-header -rN`, `-k <expr>` |
| Maven / Gradle | `-B -q`, `--console=plain -q`, `-Dtest=<Class>` / `--tests` |
| Go | `go test ./pkg/...` (no `-v`), `-run <Name>` |
| .NET | `dotnet test -v q --nologo` |
| Docker | `docker build --progress=plain -q`, `docker ps --format '{{.Names}}\t{{.Status}}'` |
| kubectl | `-o name`, `--no-headers`, `logs --tail=200 --since=30m` |
| Cloud CLIs | `--query` / `--output text`, `--format="value(...)"`, `--max-items` |
| Search | `rg -n --max-count 5`, `-l` for file lists, `| head -50` |

## 6. About RTK and similar tools

RTK (Rust Token Killer) and similar CLI proxies use the same idea by rewriting commands to their own binary before execution. This library does **not** install or depend on them. Do not install one yourself. If the user asks about one, point out that it is a third-party dependency that needs a security review (pinned version, checksum, telemetry off), and that two output optimisers should not run at once.

## Never

- Disable cloud-guard or tests to "save tokens".
- Delete or edit `.cloud-guard/` (guard-blocked); configuration changes are made by the user.
- Assume a trimmed output is complete; check the log when the omitted part matters.
