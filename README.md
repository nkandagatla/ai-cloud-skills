# ai-cloud-skills: the company skills library

**How we build, deploy and operate, written so AI coding agents can follow it.** 97 guardrailed skills cover AWS, Azure and Google Cloud, git, HTML/CSS, JavaScript/TypeScript, Node.js, Python, Java/Spring, Go, .NET, shell, databases and AI token cost. They ship with two hooks:

- **cloud-guard** checks every command and file access before the agent runs it (cloud, git, databases, shell, publishing, secrets).
- **token-saver** trims oversized command output after it runs, keeps errors and summaries, and saves the full log, without rewriting the conversation history.

It works with Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf and any tool that reads the open Agent Skills format (`SKILL.md`).

```bash
npx github:nkandagatla/ai-cloud-skills install
```

**Start here:** [docs/USAGE.md](docs/USAGE.md) (repo or global setup, using skills in each tool, reports) · [docs/EXAMPLES.md](docs/EXAMPLES.md) (what changes with and without the skills).

> Forking this for another org? Set `config.repo` in `package.json` and run `npm run build`; it updates the site, plugin manifest and docs links.

## Why

Agents are now good enough to run migrations, force-push, rotate IAM or "quickly open port 22". The common failures are not bad code. They are:

1. **Wrong target**: prod profile, prod database host, `main` branch, prod kube context.
2. **Silent security regressions**: public buckets, `0.0.0.0/0` on RDP, `GRANT ALL`, long-lived keys, logging switched off.
3. **Secrets and personal data in the transcript**: `.env` reads, `get-secret-value`, `SELECT *` on customer tables, passwords on command lines.
4. **Unreviewed, irreversible changes**: `-auto-approve`, `git push -f origin main`, `DELETE` without `WHERE`, `npm publish`.
5. **Token waste**: 20,000-line test logs and install output flooding the context on every turn.
6. **Prompt injection** from issues, logs, tags and query results.

The skills teach the right way to do the work. The guard makes the dangerous paths mechanically unavailable. The token saver keeps sessions cheap without losing information.

## Skill packs

| Pack | Skills | Highlights |
| --- | --- | --- |
| `core` | 22 | `engineering-guardrails`, `cloud-guardrails`, `cloud-change-plan`, IaC review, Terraform, policy-as-code, secrets, CI/CD OIDC, Kubernetes, incidents, DR, compliance, FinOps, supply chain, GenAI, `/ask-skills` router, `/write-company-skill` |
| `aws` / `azure` / `gcp` | 15 each | Foundations, IAM, governance, networking, compute, Kubernetes, serverless/containers, storage, databases, keys/secrets, observability, cost, IaC, security auto-remediation |
| `git` | 5 | Workflow, commits and PRs, recovery, secrets in history, repo standards |
| `lang` | 10 | `code-fundamentals` (definition of done: lint, unit tests per function, error handling), `secure-coding`, HTML/CSS, JavaScript/TypeScript, Node.js, Python, Java/Spring, Go, .NET/C#, shell (Bash/PowerShell) |
| `db` | 9 | `db-guardrails`, SQL safety and performance, migrations, PostgreSQL, MySQL, SQL Server, MongoDB, Redis, access control |
| `ai` | 6 | Team AI token cost control, `token-saver`, context management, LLM application cost control, prompt caching, batch processing |

Every skill defers to a guardrails skill, has a `## Never` section, and its example commands are checked against the guard in CI.

## Install

### Any agent, per repository (recommended)

Run inside the repository your agent works in:

```bash
npx github:nkandagatla/ai-cloud-skills install                                   # interactive
npx github:nkandagatla/ai-cloud-skills install --agents claude,cursor --packs aws,git,lang,db,ai
npx github:nkandagatla/ai-cloud-skills install --packs git,lang,db,ai              # no cloud packs
npx github:nkandagatla/ai-cloud-skills install --mode readonly                    # agent can only read and plan
npx github:nkandagatla/ai-cloud-skills install --with-ci --with-precommit
npx github:nkandagatla/ai-cloud-skills install --scope user                      # every repo on this machine
npx github:nkandagatla/ai-cloud-skills doctor
npx github:nkandagatla/ai-cloud-skills uninstall
```

Then run **`/setup-cloud-skills`** once in your agent. It writes `CLOUD.md` and proposes `.cloud-guard/policy.json`, listing your production accounts, subscriptions, projects, clusters and database hosts.

What the installer writes:

| Agent | Skills | Guard | Token saver | Instructions |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/skills/` | `PreToolUse` hook + `permissions.deny` | `PostToolUse` hook (automatic) | `CLAUDE.md` block |
| OpenAI Codex | `.agents/skills/` (+ `agents/openai.yaml`) | instructions + `check` CLI | `token-saver run --` wrapper | `AGENTS.md` block |
| Cursor | `.agents/skills/` | `beforeShellExecution` + `beforeReadFile` hooks (fail-closed) | wrapper | `.cursor/rules/cloud-guardrails.mdc` |
| GitHub Copilot | `.agents/skills/` | instructions + `check` CLI | wrapper | `.github/copilot-instructions.md` block |
| Gemini CLI | `.agents/skills/` | `BeforeTool` hook | wrapper | `GEMINI.md` block |
| Windsurf | `.agents/skills/` | instructions + `check` CLI | wrapper | `.windsurf/rules/` |
| Others | `.agents/skills/` | instructions + `check` CLI | wrapper | `AGENTS.md` block |

Existing settings files are merged, never overwritten; invalid JSON is left alone with an error. `--no-token-saver` skips the output hook.

### Claude Code plugin

```bash
claude plugin marketplace add nkandagatla/ai-cloud-skills
claude plugin install ai-cloud-skills@ai-cloud-skills          # everything
claude plugin install ai-cloud-skills-dev@ai-cloud-skills      # core + git, languages, databases, AI cost
claude plugin install ai-cloud-skills-aws@ai-cloud-skills      # core + AWS (also -azure, -gcp)
```

The plugins include both hooks. Use either a plugin or the per-repo Claude install, not both.

### Skills only (no guard, no token saver)

```bash
gemini skills install https://github.com/nkandagatla/ai-cloud-skills.git --path skills/core
npx skills@latest add nkandagatla/ai-cloud-skills
```

## Use it in your tool

Skills load automatically when your request matches their description, or you call one by name:

| Tool | Call a skill | List skills |
| --- | --- | --- |
| Claude Code (terminal, VS Code, JetBrains) | `/aws-iam review infra/iam.tf` | `/` |
| OpenAI Codex (CLI, VS Code) | `$aws-iam review infra/iam.tf` | `/skills` |
| GitHub Copilot (VS Code agent mode, CLI) | `/aws-iam review infra/iam.tf` | `/skills` |
| Cursor | `/aws-iam review infra/iam.tf` | `/` |
| Gemini CLI | "use the aws-iam skill" (approve activation) | `/skills list` |
| Windsurf / others | "follow .agents/skills/aws-iam/SKILL.md" | `npx … list` |

Not sure which skill? `/ask-skills <what you need>`. More prompt examples: [docs/USAGE.md](docs/USAGE.md#2-using-the-skills-while-prompting).

## Repo or global?

| | Per repository (`install`) | Global (`install --scope user`) |
| --- | --- | --- |
| Who gets it | Everyone who clones the repo, every tool, CI | Only you, every repo on this laptop |
| Prod list / guard policy | Committed, reviewed in PRs | Defaults unless the repo has its own policy |
| Best for | Team repos, IaC repos, anything touching prod | Personal and scratch repos |

**Use per-repo for team and infrastructure repositories** (versioned, reviewed, the same for everyone). Use global for your own repos. Don't install both for the same agent. Examples A–F: [docs/USAGE.md](docs/USAGE.md#examples).

## Reports: how much was guarded and saved

```bash
node .cloud-guard/bin/report.mjs                           # last 30 days, text
node .cloud-guard/bin/report.mjs --price 3 --html report.html   # dashboard with $ estimate
node .cloud-guard/bin/report.mjs --md                      # paste into a PR or wiki
node .cloud-guard/bin/report.mjs --dirs ../api,../infra    # several repos
npx github:nkandagatla/ai-cloud-skills report         # same, via the CLI
```

Shows actions checked, approvals, blocks by protection type (secrets, public exposure, privilege, destructive, prod changes, unreviewed applies), top blocked rules, and tokens and dollars saved by the token saver. Data stays local; the stats file holds no command text. Preview with sample data: `node scripts/demo-data.mjs /tmp/demo && node guard/report.mjs --dirs /tmp/demo --html demo.html`.

## Skills

<!-- skills:begin -->
### Core (guardrails and cross-cloud) (22)

| Skill | What it covers |
| --- | --- |
| [`ask-skills`](./skills/core/ask-skills/SKILL.md) `/cmd` | Router for the company skills library. |
| [`cicd-oidc`](./skills/core/cicd-oidc/SKILL.md) | Secure CI/CD to AWS, Azure and GCP with OIDC federation (no stored cloud keys) for GitHub Actions, GitLab CI and Azure DevOps - trust policies, plan-on-PR / apply-on-merge pipelines, environment approvals and pipeline hardening. |
| [`cloud-change-plan`](./skills/core/cloud-change-plan/SKILL.md) | The plan, approve, apply, verify, rollback protocol for any change to cloud infrastructure or Kubernetes. |
| [`cloud-compliance-mapping`](./skills/core/cloud-compliance-mapping/SKILL.md) | Map cloud controls on AWS, Azure and GCP to compliance frameworks (CIS Benchmarks, NIST 800-53, SOC 2, ISO 27001, PCI DSS 4.0, HIPAA, GDPR data residency) and gather audit evidence with native tools. |
| [`cloud-dr-backup`](./skills/core/cloud-dr-backup/SKILL.md) | Backup, restore and disaster recovery on AWS, Azure and GCP - RPO/RTO tiers, AWS Backup, Azure Backup/Site Recovery, GCP Backup and DR, immutable and cross-region/cross-account copies, ransomware protection and restore drills. |
| [`cloud-guardrails`](./skills/core/cloud-guardrails/SKILL.md) | Non-negotiable safety rules for any work that touches AWS, Azure, Google Cloud, Kubernetes or infrastructure-as-code. |
| [`cloud-incident-response`](./skills/core/cloud-incident-response/SKILL.md) | Incident triage and response on AWS, Azure and GCP - outages, performance degradation, failed deploys, and security incidents such as leaked credentials, public data exposure, crypto-mining or suspicious IAM activity. Read-only investigation first, containment with approval, evidence preservation and blameless postmortems. |
| [`cloud-mcp-setup`](./skills/core/cloud-mcp-setup/SKILL.md) `/cmd` | Connect AI agents to AWS, Azure and Google Cloud through official MCP servers in read-only mode, with dedicated least-privilege identities, for Claude Code, Cursor, VS Code Copilot, Gemini CLI and Codex. |
| [`cloud-migration-mapping`](./skills/core/cloud-migration-mapping/SKILL.md) | Map services and concepts between AWS, Azure and Google Cloud, and plan migrations (rehost/replatform/refactor) with data transfer, identity, networking and cutover guardrails. |
| [`cloud-tagging-naming`](./skills/core/cloud-tagging-naming/SKILL.md) | Naming conventions and tagging/labelling standards for AWS, Azure and GCP, with enforcement (tag policies, Azure Policy, org policy/labels in IaC) and cost allocation. |
| [`container-supply-chain`](./skills/core/container-supply-chain/SKILL.md) | Secure container and artifact supply chain across ECR, ACR, Artifact Registry - minimal base images, Dockerfile hardening, vulnerability scanning, SBOMs, signing with cosign/Notation, provenance (SLSA), registry access control, and admission policies that only allow signed images. |
| [`engineering-guardrails`](./skills/core/engineering-guardrails/SKILL.md) | Non-negotiable safety rules for everyday engineering work by an AI agent - source control, code changes, dependencies, databases, secrets, publishing artifacts, shell commands and AI token spend. |
| [`finops-preflight`](./skills/core/finops-preflight/SKILL.md) | Estimate and control cost before creating or changing cloud resources on AWS, Azure or GCP - Infracost on Terraform plans, pricing calculators/APIs, budget alerts, and expensive-resource red flags (NAT, GPUs, cross-AZ/egress, provisioned throughput, logs). |
| [`genai-platforms`](./skills/core/genai-platforms/SKILL.md) | Build and operate generative AI workloads safely on Amazon Bedrock, Azure OpenAI / Azure AI Foundry and Google Vertex AI (Gemini) - model access, private networking, identity, content safety guardrails, prompt-injection defence, RAG data security, logging, quotas and cost controls. |
| [`iac-security-review`](./skills/core/iac-security-review/SKILL.md) | Security and correctness review of infrastructure-as-code changes (Terraform/OpenTofu, CloudFormation, CDK, SAM, Bicep/ARM, Pulumi, Helm/Kubernetes manifests) for AWS, Azure and GCP. |
| [`kubernetes-ops`](./skills/core/kubernetes-ops/SKILL.md) | Safe Kubernetes operations on EKS, AKS and GKE - context checks, read-only triage, deployments, rollbacks, scaling, RBAC, Pod Security, NetworkPolicies, secrets handling, node maintenance and upgrades. |
| [`policy-as-code`](./skills/core/policy-as-code/SKILL.md) | Set up and run policy-as-code guardrails for infrastructure - Checkov, Trivy/tfsec, TFLint, OPA/Conftest, cfn-guard, PSRule for Azure, Kyverno/Gatekeeper, pre-commit and CI gates - plus cloud-native preventive controls (SCPs, Azure Policy, GCP Org Policy). |
| [`secrets-and-identity`](./skills/core/secrets-and-identity/SKILL.md) | Cross-cloud patterns for workload identity and secrets - IAM roles, IRSA/EKS Pod Identity, Azure managed identity and workload identity, GCP service accounts and Workload Identity Federation, secret managers, rotation, and how to remove long-lived keys. |
| [`setup-cloud-skills`](./skills/core/setup-cloud-skills/SKILL.md) `/cmd` | One-time setup per repository. |
| [`terraform-workflow`](./skills/core/terraform-workflow/SKILL.md) | Safe day-to-day Terraform/OpenTofu/Terragrunt workflow for AWS, Azure and GCP - repo layout, remote state with locking and encryption, provider/module pinning, plan review, imports, moved/removed blocks, drift detection and state recovery. |
| [`well-architected-review`](./skills/core/well-architected-review/SKILL.md) `/cmd` | Architecture review of a workload against the AWS Well-Architected Framework, Azure Well-Architected Framework and Google Cloud Architecture Framework pillars (security, reliability, cost, performance, operational excellence, sustainability), producing a prioritized risk register. |
| [`write-company-skill`](./skills/core/write-company-skill/SKILL.md) `/cmd` | Author a new company skill (or improve an existing one) for this library - scoping, the SKILL.md template, guardrail requirements, examples that pass the guard, review checklist, and the build/validate steps. |

### Amazon Web Services (15)

| Skill | What it covers |
| --- | --- |
| [`aws-cloudformation-cdk`](./skills/aws/aws-cloudformation-cdk/SKILL.md) | Author, review and deploy AWS CloudFormation, SAM and CDK safely - change sets, stack policies, termination protection, drift detection, StackSets, cdk diff/synth, cdk-nag, bootstrap security, rollback and recovery from UPDATE_ROLLBACK_FAILED. |
| [`aws-cost-optimization`](./skills/aws/aws-cost-optimization/SKILL.md) | Analyse and reduce AWS spend - Cost Explorer and CUR/Data Exports queries, top cost drivers, rightsizing with Compute Optimizer, Savings Plans/RI coverage analysis, idle and orphaned resources, storage and data-transfer savings, Graviton/Spot, budgets and anomaly detection. |
| [`aws-databases`](./skills/aws/aws-databases/SKILL.md) | Secure and operate AWS databases - RDS and Aurora (PostgreSQL/MySQL/SQL Server), DynamoDB, ElastiCache/MemoryDB - private networking, encryption, IAM and Secrets Manager auth, backups/PITR, Multi-AZ and global replicas, parameter changes, upgrades, failover, performance troubleshooting. |
| [`aws-ec2-autoscaling`](./skills/aws/aws-ec2-autoscaling/SKILL.md) | Operate EC2 and Auto Scaling groups safely - launch templates, AMIs and golden images, IMDSv2, EBS encryption, SSM Session Manager/Patch Manager/Run Command, instance refresh, scaling policies, Spot/Graviton, and troubleshooting unhealthy or unreachable instances. |
| [`aws-ecs-fargate`](./skills/aws/aws-ecs-fargate/SKILL.md) | Build, deploy and troubleshoot containers on Amazon ECS (Fargate and EC2) - task definitions with task/execution roles, secrets injection, awsvpc networking, service deployments (rolling, circuit breaker, blue/green), ECS Exec, autoscaling and logging. |
| [`aws-eks`](./skills/aws/aws-eks/SKILL.md) | Build and operate Amazon EKS securely - cluster endpoint access, access entries, EKS Pod Identity/IRSA, managed node groups/Karpenter/Auto Mode, add-ons, VPC CNI, AWS Load Balancer Controller, secrets encryption, logging, GuardDuty runtime, upgrades and troubleshooting. |
| [`aws-foundations`](./skills/aws/aws-foundations/SKILL.md) | AWS basics done safely - CLI v2 profiles and IAM Identity Center (SSO) login, account/region targeting, multi-account landing zone layout (Control Tower, OUs), account baseline (root lockdown, CloudTrail, Config, GuardDuty, Security Hub, budgets) and service quotas. |
| [`aws-iam`](./skills/aws/aws-iam/SKILL.md) | Design, write, review and troubleshoot AWS IAM - least-privilege policies, roles and trust policies, permission boundaries, ABAC with tags, resource policies, cross-account access, IAM Identity Center permission sets, Access Analyzer, and AccessDenied debugging. |
| [`aws-kms-secrets`](./skills/aws/aws-kms-secrets/SKILL.md) | AWS encryption keys and secrets - KMS key design, key policies and grants, rotation, multi-region keys, Secrets Manager (rotation, replication, resource policies), SSM Parameter Store SecureString, ACM certificates, and troubleshooting KMS AccessDenied. |
| [`aws-networking`](./skills/aws/aws-networking/SKILL.md) | AWS networking design and operations - VPC/subnet/CIDR planning, security groups and NACLs, NAT and egress, VPC endpoints/PrivateLink, Transit Gateway, VPN/Direct Connect, Route 53 (public/private/Resolver), load balancers, CloudFront/WAF, flow logs and Reachability Analyzer troubleshooting. |
| [`aws-observability`](./skills/aws/aws-observability/SKILL.md) | AWS monitoring and logging - CloudWatch metrics, alarms, dashboards, Logs Insights queries, log retention and cost, X-Ray/Application Signals/OpenTelemetry, Container Insights, CloudTrail investigation and CloudTrail Lake, SLOs and alert design. |
| [`aws-organizations-governance`](./skills/aws/aws-organizations-governance/SKILL.md) | AWS multi-account governance and security posture - Organizations, OUs, Service Control Policies, Resource Control Policies, Control Tower controls, delegated administrators, org-wide CloudTrail/Config/GuardDuty/Security Hub/Inspector/Macie, and declarative policies. |
| [`aws-s3`](./skills/aws/aws-s3/SKILL.md) | Secure and operate Amazon S3 - Block Public Access, bucket policies, Object Ownership, encryption (SSE-S3/SSE-KMS/DSSE), versioning, Object Lock, lifecycle, replication, access points, presigned URLs, CloudFront OAC for public content, access logging, Macie, and troubleshooting 403s. |
| [`aws-security-automation`](./skills/aws/aws-security-automation/SKILL.md) | Build guarded security auto-remediation on AWS - EventBridge rules on GuardDuty/Security Hub/Config/CloudTrail events, Lambda and SSM Automation runbooks, AWS Config remediation, Security Hub automation rules, notification pipelines, with dry-run, scoping, kill switches and audit trails. |
| [`aws-serverless`](./skills/aws/aws-serverless/SKILL.md) | Build and operate AWS serverless applications - Lambda (roles, packaging, versions/aliases, concurrency, VPC, layers, function URLs), API Gateway (REST/HTTP, authorizers, WAF, throttling), Step Functions, EventBridge, SQS/SNS (DLQs, idempotency), with SAM/CDK/Terraform deployment and troubleshooting. |

### Microsoft Azure (15)

| Skill | What it covers |
| --- | --- |
| [`azure-aks`](./skills/azure/azure-aks/SKILL.md) | Build and operate Azure Kubernetes Service securely - Entra ID integration with Azure RBAC, local accounts disabled, private cluster/authorized IPs, workload identity, node pools and upgrades (auto-upgrade channels, node OS), Azure CNI Overlay/Cilium, network policies, Key Vault CSI, Azure Policy add-on, Defender for Containers, and troubleshooting. |
| [`azure-app-service-functions`](./skills/azure/azure-app-service-functions/SKILL.md) | Secure and operate Azure App Service (Web Apps) and Azure Functions - plans (Flex Consumption, Premium, Dedicated), managed identity, Key Vault references, VNet integration and private endpoints, deployment slots and zero-downtime swaps, Easy Auth, TLS/FTPS settings, App Insights, scaling and troubleshooting. |
| [`azure-bicep`](./skills/azure/azure-bicep/SKILL.md) | Author, review and deploy Azure Bicep/ARM safely - module structure, Azure Verified Modules, parameters files (.bicepparam), @secure() params and Key Vault references, linter configuration, what-if, incremental vs complete mode, Deployment Stacks with deny settings, deployment scopes, and troubleshooting failed deployments. |
| [`azure-container-apps`](./skills/azure/azure-container-apps/SKILL.md) | Deploy and operate Azure Container Apps and Azure Container Registry securely - environments with VNet integration and internal ingress, managed identity image pulls, Key Vault secret references, revisions and traffic splitting, KEDA scaling, Dapr, jobs, and troubleshooting. |
| [`azure-cost-management`](./skills/azure/azure-cost-management/SKILL.md) | Analyse and reduce Azure spend - Cost Management queries and exports, top cost drivers by service/resource group/tag, Azure Advisor cost recommendations, reservations and savings plan analysis, idle and orphaned resources, VM/AKS/database rightsizing, storage tiering, Log Analytics costs, budgets and anomaly alerts. |
| [`azure-databases`](./skills/azure/azure-databases/SKILL.md) | Secure and operate Azure databases - Azure SQL Database/Managed Instance, Azure Database for PostgreSQL/MySQL Flexible Server, Cosmos DB, Azure Cache for Redis - Entra-only authentication, private endpoints, TDE with CMK, auditing, Defender for SQL, backups/PITR/LTR, geo-replication and failover groups, scaling and performance troubleshooting. |
| [`azure-entra-rbac`](./skills/azure/azure-entra-rbac/SKILL.md) | Azure identity and access - Entra ID users/groups/apps/service principals, managed identities, workload identity federation, Azure RBAC role assignments and custom roles, PIM, Conditional Access, data-plane roles, and troubleshooting AuthorizationFailed. |
| [`azure-foundations`](./skills/azure/azure-foundations/SKILL.md) | Azure basics done safely - az CLI login and subscription targeting, tenants/management groups/subscriptions/resource groups hierarchy, Azure Landing Zones (CAF), subscription baseline (Defender, Activity Log export, policies, budgets, locks), resource providers and quotas. |
| [`azure-key-vault`](./skills/azure/azure-key-vault/SKILL.md) | Azure Key Vault and Managed HSM - RBAC authorization mode, network isolation, soft delete and purge protection, secrets/keys/certificates lifecycle, rotation policies and near-expiry events, Key Vault references, CMK for other services, and troubleshooting access. |
| [`azure-monitor`](./skills/azure/azure-monitor/SKILL.md) | Azure observability - Log Analytics KQL queries, Application Insights, Azure Monitor metrics and alerts (metric, log search, activity log, Service Health), action groups, diagnostic settings, Data Collection Rules, Managed Prometheus/Grafana, Activity Log investigations, retention and cost. |
| [`azure-networking`](./skills/azure/azure-networking/SKILL.md) | Azure networking design and operations - VNets/subnets/IP planning, NSGs and ASGs, hub-spoke and Virtual WAN, Azure Firewall, UDRs, Private Endpoints and Private DNS zones, service endpoints, NAT Gateway, Application Gateway/WAF, Front Door, Load Balancer, Bastion, VPN/ExpressRoute, flow logs and Network Watcher troubleshooting. |
| [`azure-policy-governance`](./skills/azure/azure-policy-governance/SKILL.md) | Azure governance and security posture - Azure Policy definitions/initiatives/assignments/exemptions, effects (audit, deny, modify, deployIfNotExists), remediation tasks, Microsoft Cloud Security Benchmark, Defender for Cloud plans and secure score, resource locks, Deployment Stacks deny settings, and landing-zone guardrails. |
| [`azure-security-automation`](./skills/azure/azure-security-automation/SKILL.md) | Build guarded security auto-remediation on Azure - Defender for Cloud workflow automation and continuous export, Azure Policy remediation (modify/deployIfNotExists), Event Grid on Activity Log/Key Vault events, Logic Apps/Functions/Automation runbooks with managed identities, Sentinel automation rules and playbooks, with dry-run, scoping, kill switches and audit. |
| [`azure-storage`](./skills/azure/azure-storage/SKILL.md) | Secure and operate Azure Storage accounts - Blob/ADLS Gen2, Files, Queues, Tables - Entra ID auth and disabling shared keys, user-delegation SAS, private endpoints and network rules, encryption with CMK, soft delete/versioning/immutability, lifecycle management, replication (LRS/ZRS/GZRS), Defender for Storage, and troubleshooting 403s. |
| [`azure-vms-vmss`](./skills/azure/azure-vms-vmss/SKILL.md) | Operate Azure Virtual Machines and Virtual Machine Scale Sets securely - images (Compute Gallery, Image Builder), Trusted Launch, encryption at host/disk encryption sets, managed identity, Bastion/JIT access, Update Manager patching, Run Command, VMSS rolling upgrades and autoscale, Azure Monitor Agent, and troubleshooting boot/connectivity. |

### Google Cloud (15)

| Skill | What it covers |
| --- | --- |
| [`gcp-bigquery`](./skills/gcp/gcp-bigquery/SKILL.md) | Use and govern BigQuery safely - dataset/table IAM, authorized views and row/column-level security, policy tags and data masking, CMEK, dry runs and cost controls (maximum bytes billed, partitioning/clustering, reservations), query optimisation, data exfiltration controls (VPC-SC), audit logs and billing export analysis. |
| [`gcp-cloud-run-functions`](./skills/gcp/gcp-cloud-run-functions/SKILL.md) | Deploy and operate Cloud Run services/jobs and Cloud Run functions securely - dedicated service accounts, ingress settings and IAM invoker, IAP/load balancer fronting, Secret Manager integration, Direct VPC egress, revisions and traffic splitting, concurrency/min instances, Eventarc/Pub/Sub triggers, Binary Authorization, and troubleshooting. |
| [`gcp-cloud-storage`](./skills/gcp/gcp-cloud-storage/SKILL.md) | Secure and operate Google Cloud Storage - public access prevention, uniform bucket-level access, IAM and IAM Conditions, CMEK, soft delete, object versioning, retention policies and Bucket Lock, lifecycle rules, Autoclass, dual/multi-region, signed URLs, data access logging, and troubleshooting 403s. |
| [`gcp-compute-engine`](./skills/gcp/gcp-compute-engine/SKILL.md) | Operate Google Compute Engine and managed instance groups securely - instance templates, custom images and image families, Shielded VM, OS Login and IAP access, dedicated service accounts with minimal scopes, CMEK disks, VM Manager (OS patch, inventory), MIG autoscaling/autohealing/rolling updates, snapshots schedules, and troubleshooting. |
| [`gcp-cost-optimization`](./skills/gcp/gcp-cost-optimization/SKILL.md) | Analyse and reduce Google Cloud spend - billing export queries in BigQuery, top cost drivers by service/project/label/SKU, Recommender (idle VMs, rightsizing, idle disks/IPs, CUD recommendations), committed use discounts analysis, GKE/Cloud Run/Cloud SQL optimisation, storage classes, network egress, logging costs, budgets and alerts. |
| [`gcp-databases`](./skills/gcp/gcp-databases/SKILL.md) | Secure and operate Google Cloud databases - Cloud SQL (PostgreSQL/MySQL/SQL Server), AlloyDB, Spanner, Firestore, Bigtable and Memorystore - private IP/PSC, IAM database authentication, Cloud SQL Auth Proxy/connectors, SSL enforcement, CMEK, backups/PITR, HA and cross-region replicas, deletion protection, maintenance, and performance troubleshooting. |
| [`gcp-foundations`](./skills/gcp/gcp-foundations/SKILL.md) | Google Cloud basics done safely - gcloud auth and configurations, project/folder/organization targeting, service account impersonation, resource hierarchy and landing zone (Cloud Foundation), project baseline (audit logs, org policies, SCC, budgets, APIs), quotas and Cloud Asset Inventory. |
| [`gcp-gke`](./skills/gcp/gcp-gke/SKILL.md) | Build and operate Google Kubernetes Engine securely - Autopilot vs Standard, private clusters and control-plane access, Workload Identity Federation for GKE, Google Groups for RBAC, release channels and maintenance windows, node pools (Shielded, COS, auto-upgrade), Dataplane V2 network policy, Binary Authorization, Security Posture, Backup for GKE, and troubleshooting. |
| [`gcp-iac`](./skills/gcp/gcp-iac/SKILL.md) | Infrastructure as code on Google Cloud - Terraform google/google-beta providers with impersonation and GCS state, Cloud Foundation Fabric and terraform-google-modules, Infrastructure Manager, Config Connector (KRM), Cloud Build/Cloud Deploy pipelines, API enablement, IAM resource types pitfalls, and importing existing resources. |
| [`gcp-iam`](./skills/gcp/gcp-iam/SKILL.md) | Google Cloud IAM design, review and troubleshooting - predefined vs custom roles, additive bindings vs authoritative policies, IAM Conditions, service accounts and impersonation, Workload Identity Federation, IAM deny policies, Principal Access Boundary, Recommender/Policy Analyzer/Policy Troubleshooter, and privilege-escalation risks. |
| [`gcp-networking`](./skills/gcp/gcp-networking/SKILL.md) | Google Cloud networking design and operations - custom-mode VPCs, Shared VPC, subnets and secondary ranges, hierarchical and network firewall policies, Cloud NAT, Private Google Access and Private Service Connect, Cloud DNS (private zones, forwarding), Cloud Load Balancing and Cloud Armor, IAP TCP forwarding, VPN/Interconnect, NCC, flow logs and Connectivity Tests. |
| [`gcp-observability`](./skills/gcp/gcp-observability/SKILL.md) | Google Cloud observability - Cloud Logging queries and Log Analytics (SQL), log buckets/sinks/exclusions and retention, Cloud Monitoring metrics, MQL/PromQL, alerting policies and notification channels, uptime checks, SLOs, Cloud Trace/Profiler, Managed Service for Prometheus, and audit log investigations. |
| [`gcp-org-policy-security`](./skills/gcp/gcp-org-policy-security/SKILL.md) | Google Cloud organization governance and security posture - Organization Policy constraints (managed and custom), dry-run policies, VPC Service Controls perimeters, Security Command Center (findings, posture, mute rules), org-level audit log sinks and log buckets, Access Transparency, Assured Workloads. |
| [`gcp-secret-manager-kms`](./skills/gcp/gcp-secret-manager-kms/SKILL.md) | Google Cloud Secret Manager and Cloud KMS - secret creation and per-secret IAM, replication and CMEK, versions, rotation schedules with Pub/Sub, regional secrets, KMS key rings/keys/rotation, protection levels (software/HSM/external), CMEK for services, key IAM separation of duties, Autokey, and troubleshooting. |
| [`gcp-security-automation`](./skills/gcp/gcp-security-automation/SKILL.md) | Build guarded security auto-remediation on Google Cloud - Security Command Center notifications to Pub/Sub, Eventarc on Cloud Audit Logs, Cloud Run/Cloud Functions remediators with dedicated service accounts, log-based alerts, Workflows approvals, org policy and posture as preventive controls, with dry-run, scoping, kill switches and audit. |

### Git and source control (5)

| Skill | What it covers |
| --- | --- |
| [`git-commits-prs`](./skills/git/git-commits-prs/SKILL.md) | Write good commits and pull requests - Conventional Commits, atomic commits, commit message body, co-author/attribution, PR size and description template, linking tickets, draft PRs, review etiquette, addressing review comments, squash vs merge, and gh CLI usage. |
| [`git-recovery`](./skills/git/git-recovery/SKILL.md) | Recover from git mistakes safely - lost commits via reflog, undoing commits (reset vs revert), unstaging, restoring deleted files or branches, aborting bad rebases/merges, fixing commits on the wrong branch, detached HEAD, and recovering after a bad force push. |
| [`git-repo-standards`](./skills/git/git-repo-standards/SKILL.md) | Company repository standards - required files (README, CODEOWNERS, CONTRIBUTING, SECURITY, LICENSE, .editorconfig, .gitattributes), branch protection and rulesets, required checks, Dependabot/Renovate, PR and issue templates, signed commits, git hooks, and an audit of an existing repo against the standard. |
| [`git-secrets-history`](./skills/git/git-secrets-history/SKILL.md) | Prevent and respond to secrets in git - .gitignore and example env files, pre-commit secret scanning (gitleaks, cloud-guard scan), GitHub push protection, what to do when a secret is committed or pushed (rotate first), purging history with git filter-repo, and coordinating the force-push. |
| [`git-workflow`](./skills/git/git-workflow/SKILL.md) | Team git workflow for agents and developers - trunk-based vs GitFlow, branch naming, syncing with main (rebase vs merge), resolving conflicts, keeping branches short-lived, release branches and tags, monorepo and submodule basics, and compact git commands that save tokens. |

### Languages (10)

| Skill | What it covers |
| --- | --- |
| [`code-fundamentals`](./skills/lang/code-fundamentals/SKILL.md) | Company coding fundamentals for every language - the definition of done (format, lint, type-check, unit tests, coverage), unit tests for every function or branch with logic, error handling (try/catch at boundaries, never swallow, wrap with context, always clean up), input validation, naming, small functions, logging, and quality-gate commands for JavaScript/TypeScript, Python, Java, Kotlin, Go, C#, Rust, PHP, Ruby, C/C++, shell and HTML/CSS. |
| [`dotnet-csharp`](./skills/lang/dotnet-csharp/SKILL.md) | Company standard for .NET and C# - LTS SDK pinning with global.json, nullable reference types and analyzers, ASP.NET Core security (authentication, authorization policies, data protection, headers), configuration and Key Vault/secret manager integration, EF Core pitfalls and migrations, async best practices, logging with ILogger/Serilog, testing with xUnit/Testcontainers, and container images. |
| [`go`](./skills/lang/go/SKILL.md) | Company standard for Go - modules and toolchain pinning, project layout, error handling and wrapping, context propagation and timeouts, concurrency patterns and race detection, net/http server hardening, database/sql usage, structured logging with slog, testing (table tests, fuzzing), linting with golangci-lint, govulncheck and static binaries in distroless images. |
| [`html-css`](./skills/lang/html-css/SKILL.md) | Company standard for HTML and CSS - semantic markup, accessibility (WCAG 2.2 AA), responsive layout with flex/grid, design tokens and CSS custom properties, dark mode, forms, images and performance (Core Web Vitals), security headers and CSP, safe DOM manipulation, and linting with HTMLHint/Stylelint. |
| [`java-spring`](./skills/lang/java-spring/SKILL.md) | Company standard for Java and Spring Boot - LTS JDK, Maven/Gradle builds with wrappers and dependency management, project structure, Spring Boot configuration and profiles, Spring Security, validation, exception handling, JPA/Hibernate pitfalls (N+1, transactions), logging, Actuator hardening, testing with JUnit 5/Testcontainers, performance tuning and container images. |
| [`javascript-typescript`](./skills/lang/javascript-typescript/SKILL.md) | Company standard for JavaScript and TypeScript - strict tsconfig, ESLint/Prettier, module system (ESM), types over any, runtime validation with zod, async/await and error handling, immutability, testing with Vitest/Jest/Playwright, React/front-end safety, bundle size, and package management with npm/pnpm lockfiles. |
| [`nodejs-backend`](./skills/lang/nodejs-backend/SKILL.md) | Company standard for Node.js services - LTS versions, project layout, Express/Fastify/NestJS security middleware, config and secrets, input validation, structured logging with pino, error handling and graceful shutdown, database access and connection pooling, performance (event loop, streams, worker threads), testing, Docker images and npm supply-chain hygiene. |
| [`python`](./skills/lang/python/SKILL.md) | Company standard for Python - supported versions, uv/poetry/pip with lockfiles and virtual environments, pyproject.toml, Ruff lint and format, type hints with mypy/pyright, pydantic validation, logging, exceptions, async, FastAPI/Django/Flask security, packaging, pytest testing, data and scripting hygiene, and dependency auditing. |
| [`secure-coding`](./skills/lang/secure-coding/SKILL.md) | Language-agnostic secure coding standard for agents - OWASP Top 10 and API Top 10 defences, input validation, output encoding, injection (SQL/NoSQL/command/LDAP), authn/authz checks, secrets handling, crypto do's and don'ts, SSRF, deserialization, file uploads, logging without PII, dependency risk, and a review checklist. |
| [`shell-scripting`](./skills/lang/shell-scripting/SKILL.md) | Company standard for Bash and PowerShell scripts - strict mode, quoting, argument parsing, dry-run flags, idempotency, error handling and traps, logging, portability (Linux/macOS/Windows), ShellCheck and PSScriptAnalyzer, safe file operations, secrets handling, and when to switch to Python. |

### Databases (9)

| Skill | What it covers |
| --- | --- |
| [`db-access-control`](./skills/db/db-access-control/SKILL.md) | Design and review database access control - separate owner/migration/application/read-only/analyst roles, least-privilege grants per engine (PostgreSQL, MySQL, SQL Server, Oracle, MongoDB), cloud IAM database authentication, secret rotation, row-level security and column masking for personal data, audit logging, break-glass access and access reviews. |
| [`db-guardrails`](./skills/db/db-guardrails/SKILL.md) | Non-negotiable rules for any AI agent work against databases (PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, MongoDB, Redis, Cassandra, SQLite, warehouses) - environment tiers, read-only by default, query safety (WHERE, LIMIT, transactions, dry runs), personal data handling, credentials, migrations-only schema changes, and what is forbidden. |
| [`db-migrations`](./skills/db/db-migrations/SKILL.md) | Safe, zero-downtime database schema migrations with Flyway, Liquibase, Alembic, Django, Prisma, Knex, EF Core, golang-migrate and Rails - expand/contract pattern, backward compatibility with running code, online index and column changes per engine, large backfills, testing on production-like data, rollback strategy and pipeline application. |
| [`mongodb`](./skills/db/mongodb/SKILL.md) | Operate and troubleshoot MongoDB (self-managed, Atlas, Amazon DocumentDB, Azure Cosmos DB for MongoDB) safely - mongosh usage without credential leaks, query and aggregation safety, indexes and explain plans, schema design and validation, profiler and currentOp diagnostics, write concerns, transactions, replica set and sharding health, users/roles and network security. |
| [`mysql`](./skills/db/mysql/SKILL.md) | Operate and troubleshoot MySQL and MariaDB (self-managed, RDS/Aurora MySQL, Azure Flexible Server, Cloud SQL) safely - client usage without password leaks, performance_schema and sys schema diagnostics, slow query log, InnoDB locks and deadlocks, indexes, online DDL (INSTANT/INPLACE, gh-ost, pt-osc), replication lag, character sets, users and grants, backups and upgrades. |
| [`postgresql`](./skills/db/postgresql/SKILL.md) | Operate and troubleshoot PostgreSQL (self-managed, RDS/Aurora, Azure Flexible Server, Cloud SQL/AlloyDB) safely - psql usage, roles and privileges, connection pooling, pg_stat_statements and pg_stat_activity diagnostics, locks and blocking, vacuum/bloat, indexes, configuration, replication lag, extensions, backups and upgrades. |
| [`redis`](./skills/db/redis/SKILL.md) | Operate and troubleshoot Redis and Valkey (self-managed, ElastiCache/MemoryDB, Azure Cache/Managed Redis, Memorystore) safely - redis-cli without password leaks, key design and TTLs, SCAN instead of KEYS, memory and eviction diagnostics, big/hot keys, latency and slowlog, persistence, replication and cluster health, ACLs and TLS, and safe bulk deletes. |
| [`sql-safety-performance`](./skills/db/sql-safety-performance/SKILL.md) | Write, review and optimise SQL safely across PostgreSQL, MySQL, SQL Server and Oracle - parameterisation, correct joins and NULL handling, pagination, transactions and isolation, locking and deadlocks, indexing strategy, reading EXPLAIN plans, N+1 queries from ORMs, query anti-patterns, and safe data-fix scripts. |
| [`sql-server`](./skills/db/sql-server/SKILL.md) | Operate and troubleshoot Microsoft SQL Server and Azure SQL safely - sqlcmd/Invoke-Sqlcmd without password leaks, Entra authentication, DMVs and Query Store diagnostics, blocking and deadlocks, wait statistics, indexes and statistics maintenance, tempdb, Always On/geo-replication lag, permissions and security baseline. |

### AI token cost and context (6)

| Skill | What it covers |
| --- | --- |
| [`ai-context-management`](./skills/ai/ai-context-management/SKILL.md) | How an AI agent keeps its own context window small and useful without losing important history - loading files and logs just in time, reading surgically, delegating noisy work to subagents, keeping a handoff note, suggesting clear or compact to the user at the right moment, resuming work across sessions, and writing lean CLAUDE.md/AGENTS.md files with progressive disclosure. |
| [`ai-token-cost-control`](./skills/ai/ai-token-cost-control/SKILL.md) | How an AI coding agent keeps its own token usage and cost low (Claude Code, Codex, Copilot, Cursor, Gemini CLI) - where tokens go, compact commands and targeted reads, model and effort choice, delegating noisy work to subagents, MCP and tool overhead, output trimming with token-saver, when to suggest clearing or compacting to the user, and how to configure team cost controls or prepare an AI spend review when asked. |
| [`llm-app-cost-control`](./skills/ai/llm-app-cost-control/SKILL.md) | Control cost and token usage in applications that call LLM APIs (Anthropic Claude API, Amazon Bedrock, Azure OpenAI, Vertex AI, OpenAI) - token accounting per request, model routing, prompt caching, batch APIs, max_tokens and output limits, context trimming for chat history and RAG, response caching, rate limits, per-tenant budgets and quotas, cost observability and alerts. |
| [`llm-batch-processing`](./skills/ai/llm-batch-processing/SKILL.md) | Use batch APIs to cut LLM cost for work that does not need an immediate answer - Claude Message Batches, Amazon Bedrock batch inference, Azure OpenAI Global/Data Zone Batch, Vertex AI batch prediction and OpenAI Batch - when to batch, building JSONL/requests with custom ids, submitting and polling, handling partial failures and retries, combining with prompt caching, idempotent pipelines, security of input/output files, and cost estimation. |
| [`llm-prompt-caching`](./skills/ai/llm-prompt-caching/SKILL.md) | Implement and verify prompt caching to cut LLM input cost and latency - how prefix caching works, what to cache, prompt layout for cache hits, cache breakpoints and TTLs on the Claude API, cachePoint on Amazon Bedrock, automatic caching on Azure OpenAI/OpenAI, Gemini context caching on Vertex AI, break-even maths, measuring hit rates from usage fields, common cache-busting mistakes, and keeping agent sessions cache-friendly. |
| [`token-saver`](./skills/ai/token-saver/SKILL.md) | How to work with the token-saver that ships with this library - a Claude Code PostToolUse hook and a run wrapper that trims large command output (test runs, builds, installs, logs) before the model sees it, keeps errors and summaries, saves the full redacted output to a local log for follow-up reads, and reports savings. |

<!-- skills:end -->

## How the guard decides

| | sandbox / localhost | nonprod | unknown | prod |
| --- | --- | --- | --- | --- |
| **read** (`describe`, `list`, `plan`, `what-if`, `SELECT`, `GET`) | allow | allow | allow | allow |
| **change** (`create`, `deploy`, `apply tfplan`, `INSERT/UPDATE ... WHERE`, `SET`) | allow (`strict`: ask) | ask | ask | **deny** |
| **destructive** (`delete`, `terminate`, `destroy`, `DROP TABLE`, `DEL`) | ask | ask | ask | **deny** |
| **hard rules** (74: public data, open admin ports, admin grants, long-lived keys, audit off, secrets in commands or files, force-push to protected branches, unbounded `DELETE/UPDATE`, `DROP DATABASE`, `FLUSHALL`, `rm -rf /`, `-auto-approve`, editing the guard) | deny | deny | deny | deny |

Environment detection uses `--profile`/`AWS_PROFILE`, the active `az` subscription, gcloud configuration, kube context, Terraform directory/workspace/var files, and database hosts/URIs (`psql -h`, `mysql -h`, `sqlcmd -S`, `mongosh <uri>`, `redis-cli -h`). Try it:

```bash
node guard/cloud-guard.mjs check -- git push -f origin main                               # deny  GIT-FORCE-PROTECTED
node guard/cloud-guard.mjs check -- psql -h orders-prod.internal -c "update orders set x=1 where id=4"   # deny  ENV-MUTATE (prod)
node guard/cloud-guard.mjs check -- az vm list -g rg-orders --subscription contoso-prod   # allow
```

Configuration: [`templates/cloud-guard-README.md`](templates/cloud-guard-README.md).

## Token saver

```bash
node guard/token-saver.mjs run -- npm test        # any agent: compacted output + full log on disk
node guard/token-saver.mjs gain                   # savings report
```

In Claude Code it runs automatically as a `PostToolUse` hook: the command itself is never changed (so the guard and your permission prompts see the real command), only an oversized result is shortened, and nothing earlier in the conversation is rewritten. Details: [`skills/ai/token-saver/SKILL.md`](skills/ai/token-saver/SKILL.md). It is an independent implementation of the same idea as tools like RTK; nothing third-party is installed.

### Limits

The guard is a **seatbelt, not a sandbox**: it reads command text and file paths. Code the agent writes and runs, MCP servers, or unknown tools can bypass it. The real boundary is least-privilege credentials for the agent (read-only by default, no production write access), the platform's own controls (SCPs, Azure Policy, Org Policy, branch protection, database roles) and review. Keep your agent's approval prompts on.

## Repository layout

```
skills/
  core/  aws/  azure/  gcp/  git/  lang/  db/  ai/
guard/      cloud-guard.mjs, rules.mjs, token-saver.mjs, report.mjs (no dependencies)
docs/       USAGE.md, EXAMPLES.md
bin/        cli.mjs installer
templates/  policy.json, CI workflows, pre-commit, guard README
site/       integration page (GitHub Pages)
scripts/    build.mjs (catalog, plugin, metadata), validate.mjs (safety checks), demo-data.mjs
tests/      guard, token-saver and installer tests
```

## Adding a company skill

Run `/write-company-skill` in your agent, or follow [AGENTS.md](AGENTS.md). Then:

```bash
npm run build      # regenerate metadata, catalog, site, plugin manifest, README tables
npm run check      # build --check + validate (secret scan, guardrail references, examples vs guard) + tests
```

## License

MIT
