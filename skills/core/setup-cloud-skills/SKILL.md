---
name: setup-cloud-skills
description: One-time setup per repository. Use when installing these skills in a repo or when environments change. Interviews the user and writes CLOUD.md (environments, accounts, regions, IaC, tagging, change process) and .cloud-guard/policy.json so the cloud skills and the cloud-guard hook know what is production.
disable-model-invocation: true
---

# Setup Cloud Skills

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Run once per repository, and again whenever accounts, environments or the change process change. The output is two files the user commits:

- `CLOUD.md`: the context every cloud skill reads first.
- `.cloud-guard/policy.json`: what the cloud-guard hook enforces.

You may **read** the repo and run read-only identity commands. You may **write** `CLOUD.md`. You must **not** write `.cloud-guard/policy.json` yourself if the guard is installed (it blocks agent edits by design): print the proposed JSON and ask the user to save it.

## Step 1: Discover (read-only)

1. Detect IaC and platforms: look for `*.tf`, `terragrunt.hcl`, `*.bicep`, `azuredeploy.json`, `template.yaml` (SAM), `cdk.json`, `Pulumi.yaml`, `serverless.yml`, `Chart.yaml`, `kustomization.yaml`, `.github/workflows/*`, `azure-pipelines.yml`, `.gitlab-ci.yml`, `cloudbuild.yaml`.
2. Detect environment layout: `envs/`, `environments/`, `live/`, `*.tfvars`, workspaces, Pulumi stacks, Bicep parameter files.
3. Detect provider configuration: Terraform `backend` blocks, `provider` regions, `assume_role`, subscription ids, project ids. Collect identifiers, not secrets.
4. Run identity checks the user approves: `aws sts get-caller-identity`, `aws configure list-profiles`, `az account list --query "[].{name:name,id:id,isDefault:isDefault}" -o table`, `gcloud config configurations list`, `kubectl config get-contexts`.

Show a short summary of what you found.

## Step 2: Interview

Ask one question at a time, recommending an answer where the repo makes one obvious. Accept "skip".

1. Which clouds does this repo touch? (AWS / Azure / GCP / Kubernetes)
2. For each environment tier (**prod**, **nonprod**, **sandbox**): which AWS profiles / account ids, Azure subscription names / ids, GCP project ids, kube contexts, Terraform workspaces or directories, Pulumi stacks and **database hosts** (e.g. `orders-db.prod.internal`, RDS endpoints) belong to it? Which git branches are protected?
3. Approved regions / locations (data residency).
4. IaC tool and where state lives (S3 + DynamoDB/S3 lockfile, Azure Storage, GCS, Terraform Cloud, Pulumi Cloud).
5. How do changes reach production? (PR + CI pipeline, change ticket, CAB, manual.) Who approves?
6. Guard mode: `standard` (recommended), `strict` (even sandbox asks), or `readonly` (agent never changes anything).
7. Should prod mutations be `deny` (recommended: agent writes PRs only) or `ask`?
8. Tagging/labelling standard (required keys such as `owner`, `env`, `cost-center`, `data-classification`).
9. Monthly cost threshold above which the agent must stop and ask (default USD 100).
10. Compliance frameworks in scope (CIS, SOC 2, ISO 27001, PCI DSS, HIPAA, NIST 800-53, none).
11. Escalation contacts for security incidents (team name or channel, not personal phone numbers).

## Step 3: Write `CLOUD.md`

Use this template. Keep it short and factual; never include secrets.

```markdown
# Cloud context

Read by AI agents and humans. Owned by <team>. Last reviewed <date>.

## Environments
| Tier | AWS | Azure | GCP | Kubernetes | IaC |
| --- | --- | --- | --- | --- | --- |
| prod | profile `acme-prod` (111122223333) | sub `acme-prod` | `acme-prod` | `eks-prod-use1` | `envs/prod` |
| nonprod | ... | ... | ... | ... | `envs/dev`, `envs/stage` |
| sandbox | ... | ... | ... | ... | ... |

## Regions
Primary: us-east-1 / eastus / us-central1. DR: us-west-2 / westus3 / us-east1. No other regions.

## IaC
Terraform 1.9 with providers pinned in `versions.tf`. State: S3 `acme-tfstate` + lockfile, encrypted with KMS.
Plans run in CI on every PR; applies run from `main` with environment approval.

## Change process
- Agents: read, plan, open PRs. Never apply to prod.
- Prod: PR approved by CODEOWNERS -> pipeline -> manual approval gate.
- Emergency: follow docs/runbooks/break-glass.md (humans only).

## Standards
Tags: owner, env, cost-center, data-classification, managed-by=terraform.
Cost threshold: stop and ask above USD 100/month per change.
Compliance: SOC 2, CIS v3.

## Contacts
Security: #sec-incidents. Platform: #platform-oncall.
```

## Step 4: Propose `.cloud-guard/policy.json`

Print it for the user to save:

```json
{
  "mode": "standard",
  "prodMutations": "deny",
  "unknownEnvironmentAs": "nonprod",
  "environments": {
    "prod": ["acme-prod", "111122223333", "eks-prod-use1", "prod"],
    "nonprod": ["acme-dev", "acme-stage"],
    "sandbox": ["acme-sbx-nithin"]
  },
  "allowedRegions": ["us-east-1", "us-west-2", "eastus", "westus3", "us-central1", "us-east1"],
  "overrides": {},
  "customRules": [],
  "geminiAskAs": "deny",
  "audit": true,
  "secretWriteGuard": true,
  "tokenSaver": { "enabled": true, "maxChars": 6000 }
}
```

Explain each choice in one line. Then tell the user to verify the guard: `node .cloud-guard/bin/cloud-guard.mjs explain` and `node .cloud-guard/bin/cloud-guard.mjs check -- aws --profile acme-prod s3 mb s3://x` (expected: deny).

## Step 5: Optional extras

Offer, do not force:

- `pre-commit` secret scan and IaC scanning (see `policy-as-code`).
- A CI workflow from `templates/github-actions/` (OIDC auth, plan on PR, Checkov, guard scan).
- `cloud-mcp-setup` to connect read-only cloud MCP servers.
- Add `.cloud-guard/audit.jsonl` to `.gitignore` (the installer already does this).
