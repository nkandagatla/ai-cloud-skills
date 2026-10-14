---
name: git-secrets-history
description: Prevent and respond to secrets in git - .gitignore and example env files, pre-commit secret scanning (gitleaks, cloud-guard scan), GitHub push protection, what to do when a secret is committed or pushed (rotate first), purging history with git filter-repo, and coordinating the force-push. Use when setting up secret scanning, when a secret or credential is found in a repo, or before making a repository public.
---

# Git: Secrets and History

Load `engineering-guardrails` first. **Once a secret is pushed, assume it is compromised.** Removing it from history reduces future exposure; it does not undo the leak. Rotation always comes first.

## 1. Prevent

`.gitignore` essentials:

```gitignore
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
id_rsa*
*.tfstate
*.tfstate.*
*.tfvars
!example.tfvars
.terraform/
credentials*.json
service-account*.json
.npmrc
.pypirc
kubeconfig*
```

- Commit `.env.example` with variable **names** and fake values; real values come from a secret manager or the developer's local untracked file.
- Pre-commit scanning: `gitleaks` hook and `node .cloud-guard/bin/cloud-guard.mjs scan` (see `policy-as-code`, `templates/pre-commit-config.yaml`).
- Enable **GitHub secret scanning and push protection** (repo/org settings; admins). Equivalent: GitLab secret detection, Azure DevOps GitHub Advanced Security.
- CI uses OIDC federation instead of stored cloud keys (`cicd-oidc`).

Scan existing history (read-only):

```bash
gitleaks detect --source . --no-banner --redact --report-format json --report-path /tmp/gitleaks.json
gitleaks detect --source . --no-banner --redact --log-opts="--all"          # all branches
trufflehog git file://. --only-verified --no-update                          # verifies live credentials
```

Always use `--redact`; never print found secrets into the transcript. Summarise: file, commit, secret type.

## 2. Respond to a committed secret

1. **Stop** and tell the user: which secret type, where (file, commit, branch), whether it was pushed and whether the repo is public/forked/mirrored. Do not paste the value.
2. **Rotate / revoke now** (owner of the credential does it): AWS key → deactivate and create replacement via the identity flow; Azure secret → delete credential; GCP key → disable; database password → rotate; API tokens → revoke in the provider. See `cloud-incident-response`.
3. **Check usage** of the old credential in audit logs during the exposure window.
4. **Remove from the tip** with a normal commit (move to secret manager, reference by name).
5. **Decide on history rewrite** with the repo owner. Needed when: repo is or will be public, compliance requires it, or the secret cannot be rotated quickly.

## 3. Rewrite history (maintainer-led)

Use `git filter-repo` (recommended over `filter-branch` and BFG). Work on a **fresh mirror clone**, never on your working copy:

```bash
git clone --mirror git@github.com:acme/app.git app-clean.git
cd app-clean.git
# remove a file everywhere
git filter-repo --invert-paths --path config/prod.env
# or replace secret strings using an expressions file (literal==>replacement per line, kept OUTSIDE the repo)
git filter-repo --replace-text ../replacements.txt
```

Then (human, after agreement with all contributors, with branch protection temporarily adjusted):

1. Push the rewritten history (`git push --force --mirror` from the mirror: guard-blocked for agents by design).
2. Ask GitHub support to purge cached views / PR refs if the repo was public, and remove cached artifacts (Actions logs, releases, packages, forks).
3. Every contributor re-clones (old clones still contain the secret).
4. Re-enable protection; re-scan.

Your role in this flow: prepare the commands and the `replacements.txt` pattern list (with the secret value supplied by the user locally, never pasted into chat), verify the result in the mirror (`gitleaks detect --source . --redact --log-opts="--all"`), and write the communication to contributors.

## 4. Before making a repository public

- [ ] Full-history scan clean (`gitleaks --log-opts="--all"`, trufflehog)
- [ ] No internal hostnames, IPs, customer names or personal data in code, tests, fixtures or history
- [ ] Licence and third-party notices present
- [ ] CI secrets reviewed; workflows safe for forks (`pull_request_target` reviewed)
- [ ] Issues/PR history checked for sensitive content

## Never

- Paste a discovered secret into chat, a ticket, a PR or a commit message, even to "show" it.
- Rewrite history before the credential is rotated, or treat history rewrite as the fix.
- Run filter-repo on a working copy with uncommitted work, or force-push rewritten history yourself (guard-blocked).
- Store real secrets in `.env.example`, test fixtures or documentation.
