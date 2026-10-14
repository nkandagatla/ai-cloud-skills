---
name: write-company-skill
description: Author a new company skill (or improve an existing one) for this library - scoping, the SKILL.md template, guardrail requirements, examples that pass the guard, review checklist, and the build/validate steps. Use when a team wants to document a process, platform or standard as an agent skill.
disable-model-invocation: true
---

# Write a Company Skill

> Follow `engineering-guardrails` first. Skills are instructions an AI agent will follow at speed; unsafe guidance in a skill becomes unsafe action.

This library is the company's shared, agent-readable documentation. A good skill turns a team's tribal knowledge (how we deploy, how we name things, how we run a migration) into steps an agent can follow safely and a new engineer can read.

## 1. Scope it

Interview the requester, one question at a time:

1. What task should the agent be able to do with this skill? (One job per skill; split if there are several.)
2. When should it trigger? Write the exact phrases or situations ("Use when ...").
3. Which pack does it belong to? `core`, `aws`, `azure`, `gcp`, `git`, `lang`, `db`, `ai`, or a new team pack (propose a folder name).
4. Is it model-invoked (the agent picks it up automatically) or user-invoked (a `/command` the user runs)? User-invoked for setup, reviews and anything with side effects.
5. What must never happen? (These become the `## Never` section and, if mechanically checkable, a guard custom rule.)
6. What are the sources of truth (runbooks, wiki pages, ADRs, owners)? Link them; do not copy secrets or internal-only URLs that should not leave the company.

Check that no existing skill already covers it (`ask-skills` index, `npx ... list`). Prefer extending a skill to creating a near-duplicate.

## 2. Template

```markdown
---
name: <kebab-case, equals folder name, <= 64 chars>
description: <What it covers, concretely>. Use when <triggers>.
---

# <Title>

Load `engineering-guardrails` (and `cloud-guardrails` / `db-guardrails` if relevant).

## 1. Context / when this applies
## 2. Standard or baseline (what good looks like, with a real snippet)
## 3. Read-only discovery (commands that only read)
## 4. How to make the change (steps, approvals, rollback)
## 5. Troubleshooting (symptom → check)
## Never
- <hard rules, each with the safe alternative>
```

Writing rules:

- **Write for the agent, not for a human reader.** A skill is instructions the agent follows: imperative, second person ("Run…", "Check…", "Never…"), and the person it works with is "the user". No tutorials, onboarding text or habit tips for people (keyboard shortcuts, team coaching, advice on how a person should prompt). When only the user can do something (approve, clear a session, change billing, run a break-glass step), say what the agent should suggest or hand over. Human-facing docs go in `README.md` or `docs/`.
- Imperative, specific, short sentences. Real commands and real snippets, with placeholders (`acme-*`, `111122223333`, `<service>`), never real ids, hostnames of production systems, keys, tokens or personal data.
- Every command that changes something is labelled as a change and routed through `cloud-change-plan` or the repo's PR flow.
- State versions where behaviour depends on them ("Terraform 1.10+", "Java 21"), and include an instruction to verify against current docs when unsure.
- Keep `SKILL.md` under 400 lines. Put long references in sibling files (`reference.md`, `examples/`) and link them; agents load them only when needed (keeps token cost down).
- Description: what + when, no `<` or `>`, under 1024 characters. It is what the agent sees before loading the skill, so make the trigger words concrete.

## 3. Guard alignment

- Run `node guard/cloud-guard.mjs check -- <command>` for every example command. If it is denied, either rewrite the example to the safe path or label it clearly as human-only (`npm run validate` enforces this for fenced shell blocks).
- If the skill introduces a new "never", consider a custom rule in the team's `.cloud-guard/policy.json` (`customRules`) or a new hard rule with tests in `guard/rules.mjs`.

## 4. Review checklist (for the PR)

- [ ] One clear job; triggers are specific
- [ ] Defers to the right guardrails skill
- [ ] Baseline is secure by default (least privilege, encryption, no public exposure)
- [ ] Changes have approval and rollback steps
- [ ] `## Never` section with safe alternatives
- [ ] No secrets, personal data, real account ids or production hostnames
- [ ] Owner team named in the PR; reviewed by that team and by security for anything touching auth, data or production
- [ ] `npm run build` and `npm run check` pass

## 5. Ship it

```bash
npm run build          # regenerates catalog, site, plugin manifest, metadata
npm run check          # validate + tests
git switch -c skill/<name> && git add skills/<pack>/<name> && git commit -m "feat(skills): add <name>"
```

Open a PR; after merge, teams pick it up by re-running the installer (`install` is idempotent) or automatically through the Claude Code plugin.
