---
name: well-architected-review
description: Architecture review of a workload against the AWS Well-Architected Framework, Azure Well-Architected Framework and Google Cloud Architecture Framework pillars (security, reliability, cost, performance, operational excellence, sustainability), producing a prioritized risk register. Use when reviewing a design, a new service before launch, or an existing workload's health.
disable-model-invocation: true
---

# Well-Architected Review

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

A structured, read-only review that ends with a short, prioritised list of risks and concrete improvements. It is not a checklist dump.

## 1. Scope

Ask (one at a time): workload name and purpose; criticality tier and RPO/RTO; environments and regions; traffic profile; data classification; compliance scope; known pain points. Read `CLOUD.md`, architecture docs, ADRs and IaC.

## 2. Gather evidence (read-only)

- IaC and diagrams in the repo.
- Resource inventory: AWS Resource Explorer / Config, Azure Resource Graph, GCP Cloud Asset Inventory.
- Posture tools: Security Hub, Trusted Advisor, Compute Optimizer; Defender for Cloud, Azure Advisor; Security Command Center, Recommender / Active Assist.
- Native review tools if the user wants them: AWS Well-Architected Tool (`aws wellarchitected list-workloads`), Azure Well-Architected Review assessment, Google Cloud Architecture Framework checklists.
- Observability: dashboards, alarms, SLOs, on-call runbooks.

## 3. Pillar questions (ask yourself; answer with evidence)

**Security**: identity per workload, no long-lived keys, MFA/SSO for humans, least privilege; network segmentation and private endpoints; encryption at rest/in transit with key ownership; secrets in a manager; detection (GuardDuty/Defender/SCC) and audit logs; patching and image scanning; incident runbooks tested.

**Reliability**: multi-AZ/zone for every tier of a prod workload; health checks and auto-healing; autoscaling with sane limits; timeouts, retries with backoff and jitter, circuit breakers; idempotent processing and DLQs; backups with tested restore (`cloud-dr-backup`); quotas monitored; dependency failure modes known; deployment strategy with automatic rollback.

**Cost**: right-sizing evidence; commitment coverage; autoscale to zero where possible; storage lifecycle; data transfer architecture; tagging for allocation; budgets and anomaly alerts.

**Performance**: right compute family; caching (CDN, Redis, DAX); database indexes and connection pooling; load tests and capacity model; latency budgets per hop; regional placement close to users.

**Operational excellence**: everything in IaC; CI/CD with automated tests and policy checks; observability (logs, metrics, traces) with SLOs and actionable alerts; runbooks; game days; postmortems with tracked actions.

**Sustainability**: utilisation; managed/serverless services; Graviton/Ampere/ARM where compatible; data retention minimisation; region carbon intensity where choice exists.

## 4. Score and prioritise

For each finding: pillar, risk (High / Medium / Low), evidence, impact if it goes wrong, recommendation, effort (S/M/L), owning skill to implement it.

High risk = likely to cause an outage, data loss, breach or major cost overrun in the next 6-12 months.

## 5. Output

```markdown
# Well-Architected Review: <workload> (<date>)
Scope • Criticality • Method • Evidence sources

## Top risks (fix first)
| # | Pillar | Risk | Finding | Evidence | Recommendation | Effort | Skill |
| 1 | Reliability | High | Single-AZ RDS in prod | rds describe: MultiAZ=false | Enable Multi-AZ (maintenance window) | S | aws-databases |

## Pillar summaries (3-5 bullets each)
## Quick wins (< 1 day)
## Longer-term roadmap (next 2 quarters)
## Not reviewed / assumptions
```

Offer to turn the top risks into tickets or IaC PRs, each through `cloud-change-plan`.
