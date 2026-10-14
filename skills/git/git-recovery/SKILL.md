---
name: git-recovery
description: Recover from git mistakes safely - lost commits via reflog, undoing commits (reset vs revert), unstaging, restoring deleted files or branches, aborting bad rebases/merges, fixing commits on the wrong branch, detached HEAD, and recovering after a bad force push. Use when something went wrong in git or before running any command that could discard work.
---

# Git Recovery

Load `engineering-guardrails` first. Recovery is almost always possible **as long as you do not run `gc --prune=now` or expire the reflog** (guard-blocked). Work read-only until you know exactly where the good state is, then change one thing at a time.

## 0. Before anything: snapshot

```bash
git status -sb
git stash list
git log --oneline --graph --decorate -20 --all
git branch backup/$(date +%Y%m%d-%H%M%S)        # cheap safety net: a branch at the current HEAD
```

## 1. Find lost work

```bash
git reflog -30                                   # every position HEAD has been in, with indexes
git reflog show feature/x -20                    # per-branch history
git fsck --lost-found --no-reflogs | head        # dangling commits (e.g. dropped stash)
```

## 2. Common situations

| Situation | Fix (safe order) |
| --- | --- |
| Unstage a file | `git restore --staged <file>` |
| Discard edits to one file | Confirm first (work is lost): `git restore <file>` |
| Undo last commit, keep changes | `git reset --soft HEAD~1` (local, unpushed only) |
| Undo a pushed commit | `git revert <sha>` (new commit; never rewrite shared history) |
| Committed to the wrong branch (unpushed) | `git branch feat/right` (keeps the commit), then on the wrong branch `git reset --soft HEAD~1` and stash/clean as needed, `git switch feat/right` |
| Deleted a branch | `git reflog` / `git log --all --oneline | grep <msg>` → `git branch <name> <sha>` |
| Lost commits after reset | `git reflog` → `git branch rescue <sha>` (or `git reset --hard <sha>` after confirming nothing else is lost) |
| Bad rebase in progress | `git rebase --abort` |
| Finished a bad rebase | `git reflog` → find `rebase (start)` entry's previous position → `git reset --hard <that sha>` (own branch only, after backup) |
| Bad merge, not pushed | `git merge --abort` (in progress) or `git reset --hard ORIG_HEAD` (after confirming) |
| Dropped a stash | `git fsck --no-reflogs | grep "dangling commit"` → inspect with `git show <sha>` → `git stash apply <sha>` |
| Detached HEAD with new commits | `git switch -c rescue/<name>` to keep them |
| Deleted a file and committed | `git checkout <sha>~1 -- path/to/file` (restores from before the deletion) |
| Someone force-pushed over shared work | Find the old tip in any clone's reflog or the PR's commits on GitHub (`gh api repos/{owner}/{repo}/events` / PR "force-pushed" timeline) → push it to a **new** branch and coordinate; do not force-push back without agreement |
| Committed a secret | Go to `git-secrets-history` (rotation first) |

`reset --hard`, `clean -f` and `checkout -- .` destroy uncommitted work: the guard asks before them. Always make the backup branch and check `git status` / `git stash list` first.

## 3. Verify the recovery

```bash
git log --oneline -10
git diff backup/<timestamp> --stat       # compare with the snapshot
npm test / pytest / mvn -q test          # whatever the project uses
```

Delete the backup branch only after the user confirms everything is right.

## Never

- `git reflog expire`, `git gc --prune=now`, `git update-ref -d` (they remove the safety net; guard-blocked).
- Force-push to fix a shared branch without coordinating with everyone who uses it.
- Run `reset --hard` / `clean -fdx` "to start fresh" without a backup branch and an explicit OK.
