---
name: ask-skills
description: Router for the company skills library. Use when you are not sure which skill or flow fits a task - cloud (AWS, Azure, GCP), infrastructure, git, languages (HTML/CSS, JS/TS, Node.js, Python, Java, Go, .NET, shell), databases, security, or AI token cost.
disable-model-invocation: true
---

# Ask Skills

> Follow `engineering-guardrails` (and `cloud-guardrails` for cloud, `db-guardrails` for databases) whatever flow you pick.

Map the user's situation to the right skill(s) and say how to chain them. Ask at most one clarifying question (usually: which cloud/language/database, or which environment).

## Flows

**New repo or new team member**: `/setup-cloud-skills` (writes `CLOUD.md` + guard policy) → `git-repo-standards` → the language skill → `cloud-mcp-setup` (optional).

**Everyday code change**: `git-workflow` → language skill (`javascript-typescript`, `nodejs-backend`, `python`, `java-spring`, `go`, `dotnet-csharp`, `html-css`, `shell-scripting`) + `secure-coding` + `code-fundamentals` (lint, unit tests, error handling) → tests → `git-commits-prs`.

**Database work**: `db-guardrails` → engine skill (`postgresql`, `mysql`, `sql-server`, `mongodb`, `redis`) → `sql-safety-performance` for queries → `db-migrations` for schema → `db-access-control` for users/roles.

**Build or change infrastructure**: `<cloud>-foundations` → service skill → `terraform-workflow` / `aws-cloudformation-cdk` / `azure-bicep` / `gcp-iac` → `iac-security-review` + `policy-as-code` → `finops-preflight` → `cloud-change-plan` → PR.

**Deploy an application**: `cicd-oidc` → `container-supply-chain` → runtime skill (`aws-ecs-fargate`, `aws-serverless`, `azure-container-apps`, `azure-app-service-functions`, `gcp-cloud-run-functions`, `aws-eks`/`azure-aks`/`gcp-gke` + `kubernetes-ops`).

**Something is broken**: `cloud-incident-response` → observability skill → service/engine skill → `git-recovery` if a git mistake → `cloud-change-plan` for fixes.

**Security**: `secure-coding` (code), `git-secrets-history` (leaked secret), `<cloud>` governance and IAM skills, `cloud-compliance-mapping` (audits), `*-security-automation` (auto-remediation).

**AI cost and context**: `ai-token-cost-control` (team setup and review), `ai-context-management` (session habits), `token-saver` (output trimming), `llm-app-cost-control` (apps calling LLM APIs), `llm-prompt-caching` (cache stable prompt prefixes), `llm-batch-processing` (discounted offline jobs), `genai-platforms` (Bedrock / Azure OpenAI / Vertex).

**Reliability and cost**: `well-architected-review`, `cloud-dr-backup`, `<cloud>-cost-*`, `cloud-tagging-naming`.

**Moving between clouds**: `cloud-migration-mapping`.

**Adding to this library**: `/write-company-skill`.

## Skill index

Core: cloud-guardrails, engineering-guardrails, setup-cloud-skills, ask-skills, write-company-skill, cloud-change-plan, iac-security-review, terraform-workflow, policy-as-code, secrets-and-identity, cicd-oidc, kubernetes-ops, cloud-incident-response, cloud-dr-backup, cloud-compliance-mapping, cloud-tagging-naming, finops-preflight, container-supply-chain, cloud-migration-mapping, cloud-mcp-setup, well-architected-review, genai-platforms.

Git: git-workflow, git-commits-prs, git-recovery, git-secrets-history, git-repo-standards.

Languages: code-fundamentals, secure-coding, html-css, javascript-typescript, nodejs-backend, python, java-spring, go, dotnet-csharp, shell-scripting.

Databases: db-guardrails, sql-safety-performance, db-migrations, postgresql, mysql, sql-server, mongodb, redis, db-access-control.

AI: ai-token-cost-control, token-saver, ai-context-management, llm-app-cost-control, llm-prompt-caching, llm-batch-processing.

AWS: aws-foundations, aws-iam, aws-organizations-governance, aws-networking, aws-ec2-autoscaling, aws-eks, aws-ecs-fargate, aws-serverless, aws-s3, aws-databases, aws-kms-secrets, aws-observability, aws-cost-optimization, aws-cloudformation-cdk, aws-security-automation.

Azure: azure-foundations, azure-entra-rbac, azure-policy-governance, azure-networking, azure-vms-vmss, azure-aks, azure-app-service-functions, azure-container-apps, azure-storage, azure-databases, azure-key-vault, azure-monitor, azure-cost-management, azure-bicep, azure-security-automation.

GCP: gcp-foundations, gcp-iam, gcp-org-policy-security, gcp-networking, gcp-compute-engine, gcp-gke, gcp-cloud-run-functions, gcp-cloud-storage, gcp-databases, gcp-bigquery, gcp-secret-manager-kms, gcp-observability, gcp-cost-optimization, gcp-iac, gcp-security-automation.
