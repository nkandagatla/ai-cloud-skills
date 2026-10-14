# Using the skills: setup, prompting and reports

This guide covers three things: where to install (repo or global), how to use the skills while prompting in each tool, and how to see what was guarded and saved.

## 1. Repo or global?

| | **Per repository** (`install`) | **Global / user** (`install --scope user`) | **Claude Code plugin** |
| --- | --- | --- | --- |
| Where files go | Inside the repo: `.claude/skills`, `.agents/skills`, `.cloud-guard/`, hook settings, `CLAUDE.md`/`AGENTS.md` blocks | Your home folder: `~/.claude/skills`, `~/.agents/skills`, `~/.cloud-guard/`, user hook settings | Claude Code's plugin cache, auto-updated |
| Who gets it | Everyone who clones the repo, in every tool | Only you, in every repo on this machine | Only you (or everyone, if the org's managed settings enable the marketplace) |
| Guard policy (prod accounts, DB hosts, regions) | `.cloud-guard/policy.json` committed with the repo, reviewed in PRs | Defaults only, unless the repo you open has its own `.cloud-guard/policy.json` | Reads the repo's `.cloud-guard/policy.json` when present |
| Updates | Re-run `install` (idempotent) in a PR | Re-run `install --scope user` | Automatic |
| Works in CI / cloud agents | Yes (files are in the repo) | No | No |
| Best for | Team repos, IaC repos, anything touching prod | Individuals across many small or personal repos | Claude Code users who want zero maintenance |

**Recommendation**

- **Team and infrastructure repositories: per repository.** The rules, the prod list and the skills are versioned with the code, reviewed like code, identical for every developer and every agent, and work in CI.
- **Individuals: global**, so personal scratch repos get the same skills and guard.
- **Do not install the same skills both globally and in the repo for the same agent**; they can appear twice. If a repo has a committed install, skip the global one for that agent (or uninstall it with `uninstall --scope user`).
- Whichever you choose, run `/setup-cloud-skills` once per repo so the guard knows what production looks like.

### Examples

```bash
# A. Team repo: everything, all agents (recommended), then commit the result in a PR
cd ~/work/payments-api
npx github:nkandagatla/ai-cloud-skills install --yes --with-ci --with-precommit
git switch -c chore/agent-skills && git add -A && git commit -m "chore: add company agent skills and guardrails"

# B. App repo that never touches cloud: only git, languages, DB and AI packs
npx github:nkandagatla/ai-cloud-skills install --packs git,lang,db,ai

# C. Infra repo on AWS only, strict mode, Claude Code and Cursor users
npx github:nkandagatla/ai-cloud-skills install --packs aws,git --agents claude,cursor --mode strict

# D. Read-only repo for auditors / production investigation
npx github:nkandagatla/ai-cloud-skills install --mode readonly

# E. Global for one developer, all repos on this laptop
npx github:nkandagatla/ai-cloud-skills install --scope user --agents claude,codex

# F. Claude Code plugin (auto-updates)
claude plugin marketplace add nkandagatla/ai-cloud-skills
claude plugin install ai-cloud-skills-dev@ai-cloud-skills      # git, languages, DB, AI cost
claude plugin install ai-cloud-skills-aws@ai-cloud-skills      # + AWS

# Check, update, remove
npx github:nkandagatla/ai-cloud-skills doctor
npx github:nkandagatla/ai-cloud-skills install --yes      # update in place
npx github:nkandagatla/ai-cloud-skills uninstall
```

Monorepo: install at the repository root. Cursor also reads nested `.cursor/skills` / `.agents/skills` if a sub-team needs extra skills.

## 2. Using the skills while prompting

Skills load in two ways:

- **Automatically**: the agent sees each skill's name and description and loads the full skill when your request matches. "Fix the failing Python test" pulls in `python`; "why is this Postgres query slow" pulls in `db-guardrails` and `postgresql`.
- **Explicitly**: you name the skill. Use this for the command-style skills (`setup-cloud-skills`, `ask-skills`, `write-company-skill`, `well-architected-review`, `cloud-mcp-setup`), which never load on their own.

| Tool | Where it runs | Call a skill explicitly | List skills |
| --- | --- | --- | --- |
| **Claude Code** | Terminal, VS Code / JetBrains extensions, desktop | `/aws-iam review infra/iam.tf` or "use the db-migrations skill to…" | type `/` |
| **OpenAI Codex** | CLI, VS Code extension | `$aws-iam review infra/iam.tf` | `/skills` |
| **GitHub Copilot** | VS Code agent mode, Copilot CLI | `/aws-iam review infra/iam.tf` | `/` menu, `/skills` |
| **Cursor** | Agent chat | `/aws-iam review infra/iam.tf` (attaches to that message) | type `/` |
| **Gemini CLI** | Terminal, VS Code companion | Ask by name ("use the postgresql skill"); approve the activation prompt | `/skills list` |
| **Windsurf** | Cascade | "follow the aws-iam skill" (rules point Cascade at the skill file) | `.windsurf/rules/` |
| **Anything else** | Any agent that reads files | "Read .agents/skills/aws-iam/SKILL.md and follow it" | `npx … list` |

In VS Code, each extension (Claude Code, Codex, Copilot, Gemini) reads the same repo files, so one per-repo install covers all of them.

### Prompt examples

```text
/ask-skills I need to rotate the database password for orders-api on Azure
/setup-cloud-skills
Fix the failing test in tests/test_refund.py                       (python + token-saver)
Why is GET /orders slow? The query is in src/orders/repo.ts        (sql-safety-performance + postgresql)
Add a "display_name" column to users without downtime              (db-migrations: expand/contract)
Review infra/modules/s3 for security issues                        (iac-security-review + aws-s3)
/well-architected-review checkout service
Rebase my branch on main; I have conflicts in package-lock.json     (git-workflow)
I committed an API key in the last commit, what now?               (git-secrets-history)
We have 40k support tickets to classify overnight, cheapest way?   (llm-batch-processing + llm-prompt-caching)
Our chatbot bill doubled this month                                 (llm-app-cost-control)
/write-company-skill our release process for mobile apps
```

### When the guard steps in

- **Ask**: your tool shows its normal approval prompt with the reason (for example "nonprod change: aws ecs update-service"). Approve or deny as usual.
- **Deny**: the agent is told why and what the safe path is (for example "write the change as IaC and open a PR"). It should not retry with a rephrased command.
- **Agents without hooks** (Codex, Copilot, Windsurf): the instructions tell the agent to run `node .cloud-guard/bin/cloud-guard.mjs check -- <command>` first. Keep their own approval prompts on.

## 3. Command-line tools

```bash
npx github:nkandagatla/ai-cloud-skills list                     # all skills
npx github:nkandagatla/ai-cloud-skills doctor                   # health check
npx github:nkandagatla/ai-cloud-skills guard check -- <cmd>     # would this be allowed?
npx github:nkandagatla/ai-cloud-skills saver run -- npm test    # run with trimmed output
npx github:nkandagatla/ai-cloud-skills report                   # what was guarded and saved

# Same tools, installed in each repo (no network needed):
node .cloud-guard/bin/cloud-guard.mjs check -- terraform apply -auto-approve
node .cloud-guard/bin/token-saver.mjs gain
node .cloud-guard/bin/report.mjs --days 30
```

## 4. Reports: how much was guarded and saved

```bash
node .cloud-guard/bin/report.mjs                          # text summary, last 30 days
node .cloud-guard/bin/report.mjs --days 7 --price 3       # $ estimate at $3 per million input tokens
node .cloud-guard/bin/report.mjs --html guard-report.html # dashboard you can open or share
node .cloud-guard/bin/report.mjs --md                     # paste into a PR, wiki or Slack
node .cloud-guard/bin/report.mjs --json                   # feed a central dashboard
node .cloud-guard/bin/report.mjs --dirs ../api,../web,../infra   # one view across repos
```

It shows:

- **Guarded**: actions checked, allowed, needed approval, blocked; production changes redirected to PRs; counts by protection type (secret exposure, public exposure, privilege escalation, destructive actions, unreviewed applies, publishing, tamper attempts); top blocked rules with the reason.
- **Saved**: large outputs trimmed, tokens before/after, tokens and dollars saved (estimate), top commands by savings, daily trends.

Data comes only from local files (`.cloud-guard/stats.jsonl`, `audit.jsonl`, `token-saver/stats.jsonl`). The stats file holds no command text. The files are gitignored. For a team-wide view, have each developer or CI job run `report --json` and collect the output centrally, or point `--dirs` at several checkouts.

To see what the dashboard looks like before you have data: `node scripts/demo-data.mjs /tmp/demo && node guard/report.mjs --dirs /tmp/demo --html demo.html` (clearly marked as sample data).

## 5. Habits that keep sessions cheap (for people)

The skills tell the agent to read narrowly, use compact commands and suggest a fresh session when it's time. These habits are yours:

- Start a fresh session (`/clear` or a new chat) when you switch to unrelated work; the agent keeps a handoff note in `.agent-notes/` so nothing important is lost.
- Give specific requests: file paths, the failing test, acceptance criteria. Vague requests trigger broad scanning.
- Use plan mode for large changes so a wrong direction is caught before code is written.
- Interrupt early (Esc in Claude Code) when the agent heads the wrong way, and rewind instead of arguing over many turns.
- Point the agent at a log file instead of pasting thousands of lines into the chat.
- Check where tokens went with `/usage` and `/context` (Claude Code), `/status` (Codex), `/stats` (Gemini CLI), and `report` for what token-saver saved.
- Admins: set spend limits and `--max-budget-usd` for CI/headless runs; the skills never change billing settings.
