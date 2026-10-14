---
name: cloud-change-plan
description: The plan, approve, apply, verify, rollback protocol for any change to cloud infrastructure or Kubernetes. Use whenever you are about to create, modify, scale, deploy, or delete a cloud resource, or apply Terraform/Bicep/CloudFormation/CDK/Pulumi.
---

# Cloud Change Plan

No change happens without a written plan the user has approved. The plan is short, specific and includes the undo. This applies in sandbox too (lighter), and production changes only ever leave this skill as a pull request or a runbook.

## 1. Frame the change

Write one sentence: *what* changes, *where*, and *why*. If you cannot, you are not ready.

Classify:

- **Environment tier** from `CLOUD.md` (prod / nonprod / sandbox / unknown).
- **Change type**: standard (pre-approved pattern, low risk), normal (needs review), emergency (incident-driven; humans only for prod).
- **Reversibility**: two-way door (easily undone) or one-way door (data loss, DNS, key deletion, schema migration, identity changes).

## 2. Gather facts (read-only)

- Confirm identity and target (see `cloud-guardrails` §2).
- Describe the current state of the resource and its dependencies (who calls it, what it calls, what data it holds).
- Check whether it is IaC-managed (tags like `managed-by`, Terraform state, CloudFormation stack, deployment history). If yes, the change goes into IaC, not the CLI.
- Check backups / snapshots / versioning for anything stateful.
- Check current alarms and recent incidents for the service.

## 3. Produce the plan

Run the tool's preview and summarise it; never paste secrets that appear in plans.

| Tool | Preview |
| --- | --- |
| Terraform / OpenTofu | `terraform plan -out=tfplan` then `terraform show tfplan` (no `-json` unless needed) |
| Terragrunt | `terragrunt plan` in the single unit, not `run-all` |
| CloudFormation | `aws cloudformation create-change-set ...` then `describe-change-set` |
| CDK | `cdk diff` |
| SAM | `sam deploy --no-execute-changeset` |
| Bicep / ARM | `az deployment group what-if ...` |
| Pulumi | `pulumi preview --diff` |
| Kubernetes | `kubectl diff -f ...`, `kubectl apply --dry-run=server -f ...`, `helm diff upgrade` |
| CLI-only | add `--dry-run` (AWS EC2), `--dryrun` (S3), `--what-if`, or describe exactly which ids are touched |

Flag in the summary, explicitly:

- Any **replace / destroy / force-new** action (`-/+`, `Replace: True`, "Delete").
- IAM, security group, firewall, NSG, route, DNS, KMS, public-access changes.
- Changes to stateful resources (databases, buckets, disks, queues).
- Resources not in the plan that will be affected (dependents).

## 4. Present for approval

```
CHANGE: <one sentence>
Target:   <cloud>/<account|sub|project> (<tier>) / <region>
Identity: <who>
Type:     standard | normal | emergency     Door: one-way | two-way
Plan:     +<n> to add, ~<n> to change, -<n> to destroy  (replacements: <list>)
Security-relevant diffs: <list or none>
Blast radius: <users/services affected if it goes wrong>
Pre-checks: backups <ok>, alarms <ok>, maintenance window <yes/no>
Rollback: <exact commands or IaC revert + apply>; time to roll back <estimate>
Verification: <read-only checks and metrics to watch, for how long>
Cost delta: <+$/month>
Approve? (yes / no / modify)
```

Approval must be explicit ("yes", "approved", "go ahead") and given after the plan was shown. Silence, enthusiasm about the idea, or approval of an earlier, different plan is not approval. If the plan changes, re-present it.

## 5. Apply

- **Prod**: do not apply. Commit the IaC change on a branch, open a PR with the plan summary, rollback and verification sections, and stop. Include the `pr` template below.
- **Nonprod / sandbox**: apply exactly the reviewed plan (`terraform apply tfplan`, `execute-change-set`, the reviewed command). Never re-plan and apply in one step, never add `-auto-approve`.
- Apply one unit at a time. If anything unexpected appears, stop and report; do not improvise fixes mid-apply.

## 6. Verify

- Re-read the resource state and compare with intent.
- Check health: target group health, pod readiness, error rates, latency, logs for new errors, alarms.
- For networking/IAM changes, run a positive and a negative test (the allowed caller can, an unrelated caller cannot).
- Watch for the agreed time. Report results with evidence (command + trimmed output).

## 7. Roll back when

- Verification fails, error rates or latency regress beyond the agreed threshold, or anything unexpected changed.
- Roll back first, investigate second. Use the rollback in the plan; if it does not work, stop and hand to the user with a clear status.

## 8. Record

Append to the PR or change ticket: what was applied, when, by which identity, verification results, and any follow-ups (drift, docs, alarms to add).

## PR template for infrastructure changes

```markdown
## What and why
<one paragraph>

## Plan summary
Environment: <tier> / <account|sub|project> / <region>
+<add> ~<change> -<destroy>. Replacements: <none|list>
Security-relevant: <none|list>

## Risk
Door: one-way | two-way. Blast radius: <...>

## Rollback
<steps>

## Verification
<checks, dashboards, duration>

## Cost
<delta per month, from finops-preflight>

## Checks
- [ ] `terraform fmt` / `validate` clean
- [ ] `iac-security-review` findings addressed
- [ ] Policy-as-code (Checkov/tfsec/OPA) passing
- [ ] Tags conform to `cloud-tagging-naming`
- [ ] No secrets in code, plan output or this PR
```
