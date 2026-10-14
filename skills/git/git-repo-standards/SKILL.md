---
name: git-repo-standards
description: Company repository standards - required files (README, CODEOWNERS, CONTRIBUTING, SECURITY, LICENSE, .editorconfig, .gitattributes), branch protection and rulesets, required checks, Dependabot/Renovate, PR and issue templates, signed commits, git hooks, and an audit of an existing repo against the standard. Use when creating a new repository, auditing repo hygiene, or setting up branch protection and templates.
---

# Repository Standards

Load `engineering-guardrails` first. You may add or fix files in a repo through a PR. Repository **settings** (branch protection, rulesets, visibility, secrets) are changed by maintainers or via IaC (e.g. the Terraform GitHub provider), not by an agent calling admin APIs (guard-blocked).

## 1. Required files

| File | Purpose |
| --- | --- |
| `README.md` | What it is, how to run, test, deploy; owners; links to runbooks |
| `CODEOWNERS` (`.github/`) | Review routing; owners for `infra/`, `db/migrations/`, security-sensitive paths |
| `CONTRIBUTING.md` | Branching, commit format, PR process, local setup |
| `SECURITY.md` | How to report vulnerabilities |
| `LICENSE` | Required for open source; "Proprietary" notice internally |
| `.editorconfig` | Indentation, line endings, final newline |
| `.gitattributes` | `* text=auto eol=lf`, `*.sh text eol=lf`, `*.bat text eol=crlf`, binary/LFS patterns |
| `.gitignore` | Language template + secrets block from `git-secrets-history` |
| `AGENTS.md` / `CLAUDE.md` | Agent instructions: build/test commands, conventions, what not to touch (keep under ~200 lines; detail goes into skills) |
| `CLOUD.md` | For infra repos: environments and change process (`setup-cloud-skills`) |
| `.github/pull_request_template.md` | PR template from `git-commits-prs` |
| `.github/dependabot.yml` or `renovate.json` | Dependency updates (including GitHub Actions) |

`CODEOWNERS` example:

```
*                       @acme/payments-team
/infra/                 @acme/platform-team
/db/migrations/         @acme/payments-team @acme/dba
/.github/workflows/     @acme/platform-team
SECURITY.md             @acme/security
```

`dependabot.yml` example:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    groups: { minor-and-patch: { update-types: ["minor", "patch"] } }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
```

## 2. Branch protection / rulesets (maintainers or IaC)

For `main` and `release/*`:

- Require pull request, ≥ 1 approval (2 for infra/security paths via CODEOWNERS), dismiss stale approvals, require review from code owners.
- Require status checks: build, tests, lint, secret scan, IaC checks; require branches up to date.
- Require conversation resolution; require linear history if squash/rebase merging.
- Block force pushes and deletions; restrict who can push; no bypass for admins except an audited break-glass.
- Require signed commits if the company mandates it.
- Org-level rulesets so new repos inherit the baseline.

Terraform example (GitHub provider):

```hcl
resource "github_repository_ruleset" "main" {
  name        = "main-protection"
  repository  = github_repository.app.name
  target      = "branch"
  enforcement = "active"
  conditions { ref_name { include = ["~DEFAULT_BRANCH", "refs/heads/release/*"] exclude = [] } }
  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true
    pull_request {
      required_approving_review_count   = 1
      require_code_owner_review         = true
      dismiss_stale_reviews_on_push     = true
      required_review_thread_resolution = true
    }
    required_status_checks {
      required_check { context = "ci / check" }
      strict_required_status_checks_policy = true
    }
  }
}
```

## 3. Hooks

Use `pre-commit` (any language) or `husky` + `lint-staged` (JS). Keep hooks fast (< 10 s): format, lint changed files, secret scan. Heavy checks run in CI. Never auto-install global hooks on a developer's machine without consent.

## 4. Audit an existing repo (read-only)

```bash
ls -a ; ls .github .github/workflows 2>/dev/null
test -f .github/CODEOWNERS -o -f CODEOWNERS && echo "CODEOWNERS ok"
git ls-files | grep -Ei '\.env$|\.pem$|\.key$|tfstate|id_rsa' || echo "no obvious secret files tracked"
git ls-files -s | awk '$1 ~ /^120000/'           # symlinks (review)
git count-objects -vH                            # repo size
gh api repos/{owner}/{repo} --jq '{visibility, default_branch, allow_force_pushes: .allow_force_pushes}'
gh api repos/{owner}/{repo}/rulesets --jq '.[].name'
```

Report gaps as a checklist with the PR you propose for each file-level fix, and a list of settings changes for maintainers.

## Never

- Change repository visibility, delete repos, edit branch protection/rulesets or secrets through the API from an agent (guard-blocked).
- Add hooks that send code or data to external services.
- Put long, rarely-needed instructions in `AGENTS.md`/`CLAUDE.md` (every session pays for them); move them into skills.
