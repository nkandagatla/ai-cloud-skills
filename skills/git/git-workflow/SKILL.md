---
name: git-workflow
description: Team git workflow for agents and developers - trunk-based vs GitFlow, branch naming, syncing with main (rebase vs merge), resolving conflicts, keeping branches short-lived, release branches and tags, monorepo and submodule basics, and compact git commands that save tokens. Use when starting work on a change, updating a branch, resolving conflicts, cutting a release, or when unsure which git flow the repo uses.
---

# Git Workflow

Load `engineering-guardrails` first. Default to the repository's documented flow (`CONTRIBUTING.md`, branch protection settings). If none is documented, use **trunk-based development with short-lived branches** as below.

## 1. Orient (read-only, compact output)

```bash
git status -sb                                   # branch, ahead/behind, short file list
git remote -v
git branch --show-current
git log --oneline --decorate -15
git log --oneline main..HEAD                     # what this branch adds
git diff --stat main...HEAD                      # size of the change
git fetch --prune origin                         # safe: updates remote refs only
```

Prefer `--stat`, `--name-only`, `--oneline`, `-n`, path filters (`-- src/orders/`) over full diffs; read the full diff of one file when needed. Large outputs are trimmed automatically by the `token-saver` hook, with the full output saved for follow-up reads.

## 2. Branching

| Model | When | Branches |
| --- | --- | --- |
| **Trunk-based** (default) | Continuous delivery, feature flags | `main` + short-lived `feat/`, `fix/`, `chore/` branches (< 2-3 days) |
| **GitHub flow** | Same, PR per change | `main` + topic branches, deploy from main |
| **Release branches** | Versioned products, supported versions | `main` + `release/1.4` (only fixes cherry-picked in) |
| **GitFlow** | Only if the repo already uses it | `develop`, `release/*`, `hotfix/*`, `main` |

Branch names: `<type>/<ticket>-<short-desc>`, e.g. `feat/PAY-142-refund-endpoint`, `fix/INC-88-null-currency`. Lowercase, hyphens, no spaces.

```bash
git switch main && git pull --ff-only
git switch -c feat/PAY-142-refund-endpoint
```

## 3. Keep the branch current

- **Your own, unshared branch**: rebase for linear history.
  ```bash
  git fetch origin
  git rebase origin/main
  # after a rebase, update the remote branch safely (own branch only):
  git push --force-with-lease origin HEAD
  ```
- **Shared branch** (others push to it): merge instead of rebase: `git merge origin/main`.
- Never rebase or force-push `main`, `release/*` or anything others build on (guard-blocked).

## 4. Conflicts

1. `git status` lists conflicted files; `git diff --name-only --diff-filter=U`.
2. For each file, understand both sides (`git log --oneline -3 origin/main -- <file>`, `git log --oneline -3 HEAD -- <file>`); keep behaviour from both unless one side intentionally removed it.
3. Lockfiles: do not hand-merge. Take main's version, then regenerate with the package manager so your branch's dependency changes are re-applied: during a rebase that is `git checkout --ours package-lock.json` (see the note below), then `npm install` / `pnpm install` / `poetry lock --no-update`, and re-run tests.
4. Generated files: regenerate rather than merge.
5. Run the tests touched by both sides. Continue with `git rebase --continue` / `git commit`.
6. If it goes wrong: `git rebase --abort` / `git merge --abort` returns to the start (safe).

Remember during a **rebase** `--ours` is the branch being rebased onto (main) and `--theirs` is your commit; during a **merge** it is the reverse.

## 5. Releases and tags

```bash
git tag -a v1.4.0 -m "Release 1.4.0"     # annotated tags only; sign with -s if the repo requires
git push origin v1.4.0                    # a shared change: follow the release process
```

Semantic versioning: MAJOR for breaking changes, MINOR for features, PATCH for fixes. Releases are cut by CI from tags where possible. Never move or delete a published tag.

Hotfix on a release branch: fix on `main` first, then `git cherry-pick -x <sha>` onto `release/x.y` (the `-x` records the origin).

## 6. Monorepos, submodules, LFS

- Monorepo: scope commands to the package path (`git log -- packages/api`), use sparse checkout for huge repos (`git sparse-checkout set packages/api`), respect CODEOWNERS.
- Submodules: `git submodule update --init --recursive`; commit submodule pointer changes deliberately (they show as a single changed path).
- Large binaries belong in Git LFS (`git lfs track "*.psd"`) or artifact storage, not git history.

## 7. Worktrees for parallel work

```bash
git worktree add ../app-fix-88 -b fix/INC-88-null-currency origin/main
git worktree list
git worktree remove ../app-fix-88        # only after the work is pushed or discarded deliberately
```

Useful for agents running in parallel on separate tasks without disturbing your working tree.

## Never

- Commit directly to protected branches, force-push them, delete them, or merge with `--admin` (guard-blocked).
- Rebase branches other people are using.
- Resolve conflicts by blindly taking one side of a whole file or deleting the other side's tests.
- Run `git pull` with uncommitted changes you have not checked; stash or commit first.
