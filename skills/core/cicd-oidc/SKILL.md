---
name: cicd-oidc
description: Secure CI/CD to AWS, Azure and GCP with OIDC federation (no stored cloud keys) for GitHub Actions, GitLab CI and Azure DevOps - trust policies, plan-on-PR / apply-on-merge pipelines, environment approvals and pipeline hardening. Use when creating or reviewing a deployment pipeline or replacing CI secrets.
---

# CI/CD with OIDC

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Pipelines authenticate to clouds with short-lived tokens from OIDC federation. No cloud keys are stored in CI secrets. Plans run on pull requests with a read-only identity; applies run on the protected branch with an environment approval, using a separate identity.

## Identity design

| Identity | Trusted for | Permissions |
| --- | --- | --- |
| `ci-plan-<env>` | PRs from this repo (`pull_request`) | Read-only + state read/lock |
| `ci-apply-<env>` | `main` branch + GitHub environment `<env>` | Exactly what the IaC manages, ideally with a permission boundary |

Bind trust to **repo + ref/environment**, never to the whole org or `*`.

## AWS (GitHub Actions)

One-time (IaC, by the platform team): OIDC provider `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.

Trust policy for the apply role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:acme/infra:environment:prod"
      }
    }
  }]
}
```

Plan role `sub`: `repo:acme/infra:pull_request`. Never use `StringLike` with `repo:acme/*`.

Workflow step:

```yaml
permissions: { id-token: write, contents: read }
- uses: aws-actions/configure-aws-credentials@v4   # pin to a full commit SHA in real use
  with:
    role-to-assume: arn:aws:iam::111122223333:role/ci-apply-prod
    aws-region: us-east-1
    role-session-name: gha-${{ github.run_id }}
```

## Azure (GitHub Actions)

User-assigned managed identity (or app registration) with a federated credential:

```bash
az identity federated-credential create \
  --name gha-infra-prod --identity-name id-ci-apply-prod --resource-group rg-ci \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:acme/infra:environment:prod \
  --audiences api://AzureADTokenExchange
```

Assign roles at the narrowest scope (resource group), not subscription Owner.

```yaml
permissions: { id-token: write, contents: read }
- uses: azure/login@v2
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}        # ids are not secrets
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
```
Terraform: set `ARM_USE_OIDC=true`, `ARM_CLIENT_ID`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`; never `ARM_CLIENT_SECRET`.

## GCP (GitHub Actions)

Workload Identity Pool + OIDC provider with an **attribute condition** (mandatory):

```bash
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=ci \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository=='acme/infra' && assertion.repository_owner_id=='123456'"
```

Grant `roles/iam.workloadIdentityUser` on the deploy service account to `principalSet://iam.googleapis.com/projects/NUM/locations/global/workloadIdentityPools/ci/attribute.environment/prod` (or direct resource access to the federated principal).

```yaml
permissions: { id-token: write, contents: read }
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: projects/NUM/locations/global/workloadIdentityPools/ci/providers/github
    service_account: deploy-prod@acme-prod.iam.gserviceaccount.com
```

## GitLab CI and Azure DevOps

- GitLab: `id_tokens: { AWS_TOKEN: { aud: sts.amazonaws.com } }`; trust `sub` like `project_path:acme/infra:ref_type:branch:ref:main`. Same pattern for Azure (`aud: api://AzureADTokenExchange`) and GCP.
- Azure DevOps: use **workload identity federation** service connections (not secret-based). Restrict the service connection to specific pipelines and require approvals/checks on the environment.

## Pipeline shape

```
PR opened  → fmt/validate/lint → security scans (iac-security-review, policy-as-code) → plan (ci-plan role) → post plan summary to PR
Merge main → plan again → environment approval (humans) → apply the reviewed plan (ci-apply role) → smoke tests → notify
```

See `templates/github-actions/terraform-aws-oidc.yml`, `terraform-azure-oidc.yml`, `terraform-gcp-oidc.yml`.

## Pipeline hardening checklist

- `permissions:` minimal at workflow level; `id-token: write` only on jobs that need it.
- Pin third-party actions to a **full commit SHA**; enable Dependabot for actions.
- Do not run workflows that use cloud identities on `pull_request_target` with checkout of the PR head (code injection). Forked PRs get no cloud identity.
- Protect `main`: required reviews, CODEOWNERS for `infra/`, required status checks, no force-push.
- GitHub environments `prod` with required reviewers and branch restriction to `main`.
- Never echo tokens; mask outputs; keep `set -x` off in steps that touch credentials.
- Harden runners (ephemeral, `step-security/harden-runner` egress policy if allowed).
- Plan artifacts are sensitive; restrict retention (1-3 days) and access.
- Concurrency group per environment to prevent parallel applies.

## Reviewing an existing pipeline

Flag as **Critical**: stored cloud keys (`AWS_SECRET_ACCESS_KEY`, `ARM_CLIENT_SECRET`, `GOOGLE_CREDENTIALS`), `sub` wildcards, apply without approval, `-auto-approve` on PR events, `pull_request_target` + checkout of PR code. Propose the migration path above.
