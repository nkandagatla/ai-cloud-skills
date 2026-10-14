---
name: cloud-migration-mapping
description: Map services and concepts between AWS, Azure and Google Cloud, and plan migrations (rehost/replatform/refactor) with data transfer, identity, networking and cutover guardrails. Use when translating an architecture between clouds, answering "what is the Azure/GCP equivalent of X", or planning a migration or multi-cloud setup.
---

# Cloud Migration Mapping

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Equivalents are rarely identical. Always list the **differences that matter** (limits, semantics, pricing model, regional availability) next to the mapping, and verify current details in the provider docs before committing a design.

## Service equivalents

| Category | AWS | Azure | Google Cloud |
| --- | --- | --- | --- |
| Org hierarchy | Organizations, OUs, accounts | Tenant, management groups, subscriptions, resource groups | Organization, folders, projects |
| Landing zone | Control Tower, LZA | Azure Landing Zones (CAF), ALZ accelerators | Cloud Foundation Fabric / Security Foundations blueprint |
| Guardrails | SCPs, RCPs, Config rules | Azure Policy, deny assignments, locks | Org Policy, IAM deny policies |
| Human identity | IAM Identity Center | Entra ID (+ PIM) | Cloud Identity / Workspace |
| Workload identity | IAM roles, Pod Identity/IRSA | Managed identity, Workload Identity | Service accounts, Workload Identity Federation |
| VM | EC2 | Virtual Machines | Compute Engine |
| Autoscaling group | Auto Scaling groups | VM Scale Sets | Managed instance groups |
| Kubernetes | EKS | AKS | GKE |
| Containers serverless | ECS on Fargate, App Runner | Container Apps | Cloud Run |
| Functions | Lambda | Functions | Cloud Run functions |
| PaaS web | Elastic Beanstalk, App Runner | App Service | App Engine / Cloud Run |
| Object storage | S3 | Blob Storage (ADLS Gen2) | Cloud Storage |
| Block / file | EBS / EFS, FSx | Managed Disks / Azure Files, NetApp Files | Persistent Disk / Hyperdisk / Filestore |
| Relational | RDS, Aurora | Azure SQL, PostgreSQL/MySQL Flexible Server | Cloud SQL, AlloyDB, Spanner |
| NoSQL key-value/doc | DynamoDB, DocumentDB | Cosmos DB | Firestore, Bigtable |
| Cache | ElastiCache, MemoryDB | Azure Cache for Redis / Azure Managed Redis | Memorystore |
| Warehouse | Redshift | Synapse / Fabric | BigQuery |
| Streaming | Kinesis, MSK | Event Hubs | Pub/Sub, Managed Kafka |
| Queue / pub-sub | SQS / SNS, EventBridge | Service Bus / Event Grid | Pub/Sub, Eventarc, Cloud Tasks |
| Workflow | Step Functions | Logic Apps, Durable Functions | Workflows |
| Network | VPC, subnets, SGs, NACLs | VNet, subnets, NSGs, ASGs | VPC (global), subnets (regional), firewall policies |
| Private service access | PrivateLink, VPC endpoints | Private Endpoint / Private Link | Private Service Connect, Private Google Access |
| Hub-spoke / transit | Transit Gateway, Cloud WAN | Virtual WAN, hub VNet peering | Network Connectivity Center, Shared VPC |
| Hybrid | Site-to-Site VPN, Direct Connect | VPN Gateway, ExpressRoute | Cloud VPN, Cloud Interconnect |
| Load balancing | ALB/NLB/GWLB | Application Gateway, Load Balancer, Front Door | Cloud Load Balancing (global/regional) |
| CDN / WAF | CloudFront / AWS WAF, Shield | Front Door / WAF, DDoS Protection | Cloud CDN / Cloud Armor |
| DNS | Route 53 | Azure DNS, Traffic Manager | Cloud DNS |
| Keys / secrets | KMS, CloudHSM / Secrets Manager | Key Vault, Managed HSM | Cloud KMS, Cloud HSM / Secret Manager |
| Audit | CloudTrail | Activity Log, Entra audit | Cloud Audit Logs |
| Monitoring | CloudWatch, X-Ray, Managed Prometheus/Grafana | Azure Monitor, App Insights, Managed Prometheus/Grafana | Cloud Monitoring, Logging, Trace, Managed Prometheus |
| Threat detection / posture | GuardDuty, Security Hub, Inspector | Defender for Cloud, Sentinel | Security Command Center |
| IaC native | CloudFormation, CDK | ARM, Bicep, Deployment Stacks | Infrastructure Manager (Terraform), Config Connector |
| CI/CD | CodePipeline/CodeBuild | Azure DevOps Pipelines | Cloud Build, Cloud Deploy |
| Registry | ECR | ACR | Artifact Registry |
| GenAI | Bedrock | Azure OpenAI / AI Foundry | Vertex AI (Gemini) |
| Cost | Cost Explorer, Budgets, CUR | Cost Management, budgets, exports | Billing reports, budgets, BigQuery export |

## Differences that bite

- **VPC scope**: GCP VPCs are global with regional subnets; AWS VPCs and Azure VNets are regional.
- **IAM model**: AWS policies attach to principals/resources with explicit deny; Azure RBAC is additive role assignments at scopes (plus deny assignments, limited); GCP IAM bindings inherit down the hierarchy (plus deny policies). Translate intent, not policy text.
- **Resource groups**: Azure-only lifecycle container; map to tags/stacks elsewhere.
- **Storage semantics**: S3 strong consistency; Blob has tiers per blob and append/page blobs; GCS has storage classes per object with minimum storage durations.
- **Serverless limits**: timeouts, payload sizes, concurrency and cold-start behaviour differ (Lambda 15 min; Cloud Run up to 60 min requests; Functions plans vary).
- **Managed DB features**: versions, extensions, HA failover times, max connections, backup retention ranges.
- **Egress pricing** and inter-region charges differ significantly; model them.

## Migration playbook

1. **Discover**: inventory (Application Discovery Service / Azure Migrate / Migration Center), dependencies, data volumes, compliance constraints.
2. **Decide per workload** (7 Rs): retire, retain, rehost, relocate, replatform, refactor, repurchase.
3. **Land**: build the target landing zone first (identity, network, guardrails, logging) with the target cloud's foundations skill.
4. **Data**: choose online replication (DMS / Azure Database Migration Service / Database Migration Service, storage transfer services) with checksums and a lag SLO. Encrypt in transit; no public endpoints for replication; temporary credentials only.
5. **Rehearse** cutover in nonprod; measure downtime.
6. **Cutover** (human-executed in prod): freeze writes → final sync → verify counts/checksums → switch DNS / traffic (low TTL pre-set) → monitor → keep source read-only for rollback window.
7. **Decommission** after the rollback window, through `cloud-change-plan`, with final backups retained.

## Guardrails for migrations

- Replication users and transfer jobs get least privilege and are removed after cutover.
- Do not open source databases to the internet for migration; use VPN/interconnect/private connectivity.
- Validate data residency in the target region before copying regulated data.
- Keep both sides' audit logging on throughout.
