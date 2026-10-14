# cloud-guard

This folder was installed by [ai-cloud-skills](https://github.com/OWNER/ai-cloud-skills). It holds a pre-execution guard that checks what your AI coding agent is about to run or touch.

| File | Purpose | Commit it? |
| --- | --- | --- |
| `bin/cloud-guard.mjs`, `bin/rules.mjs` | The guard (Node 18+, no dependencies) | Yes |
| `policy.json` | Your environments, mode and overrides. **Humans only**: agents are blocked from editing it | Yes |
| `installed.json` | What the installer added (used by `doctor` / `uninstall`) | Yes |
| `audit.jsonl` | Every blocked or approval-required action (secrets redacted) | No (gitignored) |
| `bin/token-saver.mjs` | Trims oversized command output (Claude Code PostToolUse hook, or `run --` wrapper) | Yes |
| `token-saver/` | Full logs of trimmed outputs (redacted) and savings stats | No (gitignored) |

## How it decides

1. **Hard rules** (74) block catastrophic or security-breaking actions in every environment: force-push or deletion of protected branches, staging `.env`/keys, unbounded `DELETE`/`UPDATE`, `DROP DATABASE`, superuser grants, database passwords on the command line, `FLUSHALL`, `rm -rf /`, package unpublishing, plus printing secrets or tokens, reading credential files, making data public, opening admin ports to the internet, granting admin/owner, creating long-lived keys, disabling audit/detection, deleting keys/backups, unreviewed `apply`/`destroy`, editing the guard. Some risky-but-legitimate actions always **ask**.
2. **Environment matrix** for every other cloud or database CLI call (`aws`, `az`, `gcloud`, `gsutil`, `bq`, `kubectl`, `helm`, `terraform`, `tofu`, `terragrunt`, `pulumi`, `cdk`, `sam`, `eksctl`, `azd`, `psql`, `mysql`, `sqlcmd`, `sqlplus`, `mongosh`, `redis-cli`, `cqlsh`...):

| | sandbox | nonprod | unknown | prod |
| --- | --- | --- | --- | --- |
| read (`describe`, `list`, `get`, `plan`, `what-if`...) | allow | allow | allow | allow |
| change (`create`, `update`, `apply`, `deploy`...) | allow (`strict`: ask) | ask | ask | **deny** (or ask if `prodMutations: "ask"`) |
| destructive (`delete`, `destroy`, `terminate`...) | ask | ask | ask | **deny** |

`readonly` mode denies every change everywhere.

The target environment comes from `--profile` / `AWS_PROFILE`, `--subscription` / the active `az` subscription, `--project` / the active gcloud configuration, `--context` / the current kube context, and the Terraform directory, workspace and var files. It is matched against `environments` (exact ids) first, then `tierPatterns` (name tokens such as `prod`, `dev`).

3. **File guard**: agents cannot read credential stores, state files or key files, cannot write secrets into files, and cannot change `.cloud-guard/` or the agent hook settings.

## Configure (`policy.json`)

```json
{
  "mode": "standard",
  "prodMutations": "deny",
  "environments": {
    "prod": ["acme-prod", "111122223333", "contoso-prod-sub", "acme-orders-prod", "gke-prod-usc1", "envs/prod"],
    "nonprod": ["acme-dev", "acme-stage"],
    "sandbox": ["acme-sbx-nithin"]
  },
  "allowedRegions": ["us-east-1", "eastus", "us-central1"],
  "overrides": {
    "IAC-SECRET-OUTPUT": { "level": "allow", "justification": "Outputs in this repo contain no sensitive values (reviewed SEC-123)" }
  },
  "tokenSaver": { "enabled": true, "maxChars": 6000 },
  "customRules": [
    { "id": "ORG-NO-GPU", "level": "ask", "re": "--instance-type\\s+(p4|p5|g5)", "reason": "GPU instances need FinOps approval" }
  ]
}
```

- Weakening a rule in `overrides` needs a `justification` of 20+ characters, or it is ignored.
- A broken `policy.json` makes the guard fall back to `readonly`.

## Use it by hand / in CI

```bash
node .cloud-guard/bin/cloud-guard.mjs check -- aws s3api put-bucket-acl --bucket b --acl public-read   # exit 2 = deny
node .cloud-guard/bin/cloud-guard.mjs scan .                                                          # secret scan
node .cloud-guard/bin/cloud-guard.mjs explain                                                         # effective policy + rules
```

## Limits (read this)

The guard is a **seatbelt, not a sandbox**. It inspects command text and file paths; a determined process can still reach the cloud through code the agent writes and runs (an SDK script), MCP servers, or tools the guard does not know. Real protection comes from **least-privilege credentials** for the agent (read-only by default, no prod write access), the cloud's own guardrails (SCPs, Azure Policy, Org Policy), and code review. Keep your agent's own approval prompts on.
