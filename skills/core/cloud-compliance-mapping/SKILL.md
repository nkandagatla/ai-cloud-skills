---
name: cloud-compliance-mapping
description: Map cloud controls on AWS, Azure and GCP to compliance frameworks (CIS Benchmarks, NIST 800-53, SOC 2, ISO 27001, PCI DSS 4.0, HIPAA, GDPR data residency) and gather audit evidence with native tools. Use when preparing for an audit, answering a security questionnaire, or checking which cloud settings satisfy a control.
---

# Cloud Compliance Mapping

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Compliance is the evidence that security controls exist and work. This skill maps controls to cloud-native features, finds gaps, and collects **evidence** (configuration exports, reports, screenshots-as-JSON) without changing anything. Remediation goes through the normal change flow.

You are not an auditor and do not certify compliance. State findings as "control appears implemented / not implemented / partially implemented, evidence: ...".

## Native posture tools (start here)

| | Benchmark / standards available | How to read results |
| --- | --- | --- |
| AWS Security Hub CSPM | AWS Foundational Security Best Practices, CIS AWS Foundations v1.4/v3.0, PCI DSS v3.2.1/v4.0.1, NIST 800-53 r5, NIST 800-171 | `aws securityhub get-enabled-standards`; `aws securityhub get-findings --filters '{"ComplianceStatus":[{"Value":"FAILED","Comparison":"EQUALS"}],"RecordState":[{"Value":"ACTIVE","Comparison":"EQUALS"}]}' --max-items 50` |
| AWS Audit Manager | Prebuilt frameworks (SOC 2, PCI, HIPAA, GDPR, ISO 27001...) with evidence collection | `aws auditmanager list-assessments` |
| AWS Config conformance packs | Operational best practices packs per framework | `aws configservice describe-conformance-pack-compliance --conformance-pack-name X` |
| Defender for Cloud regulatory compliance | Microsoft Cloud Security Benchmark (default), CIS, NIST 800-53, PCI DSS, ISO 27001, SOC 2, HIPAA/HITRUST | `az security regulatory-compliance-standards list -o table`; `az security regulatory-compliance-controls list --standard-name X` |
| Azure Policy initiatives | Built-in regulatory initiatives | `az policy state summarize --query "policyAssignments[].{a:policyAssignmentId,nc:results.nonCompliantResources}"` |
| GCP Security Command Center | CIS GCP Foundation, NIST 800-53, PCI DSS, ISO 27001, OWASP (Premium/Enterprise) | `gcloud scc findings list ORG_ID --filter="state=\"ACTIVE\" AND finding_class=\"MISCONFIGURATION\""` |
| GCP Compliance / Assured Workloads | Data residency and regulated regimes (FedRAMP, IL, CJIS, EU) | `gcloud assured workloads list --location=LOC --organization=ORG` |

Open-source cross-cloud: Prowler (`prowler aws --compliance cis_3.0_aws`, also `azure`, `gcp`), ScoutSuite, Steampipe compliance mods. Run read-only with an audit role (AWS `SecurityAudit` + `ViewOnlyAccess`, Azure `Reader` + `Security Reader`, GCP `roles/iam.securityReviewer` + `roles/viewer`).

## Control mapping (core controls)

| Control theme | SOC 2 | ISO 27001:2022 | NIST 800-53 | PCI DSS 4.0 | AWS | Azure | GCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MFA / strong auth | CC6.1 | A.5.17, A.8.5 | IA-2 | 8.4 | IAM Identity Center MFA; root MFA | Entra MFA / Conditional Access | 2SV enforcement in Cloud Identity |
| Least privilege | CC6.3 | A.5.15, A.8.2 | AC-6 | 7.2 | IAM policies, Access Analyzer, SCPs | RBAC, PIM, access reviews | IAM roles, Recommender, deny policies |
| Audit logging | CC7.2 | A.8.15 | AU-2, AU-12 | 10.2 | CloudTrail org trail, Config | Activity Log, diagnostic settings, Entra logs | Cloud Audit Logs, org sinks |
| Log protection & retention | CC7.2 | A.8.15 | AU-9, AU-11 | 10.3, 10.5 (12 months, 3 online) | S3 Object Lock, CloudTrail Lake | Immutable storage, LA retention | Locked log buckets, retention |
| Encryption at rest | CC6.1 | A.8.24 | SC-28 | 3.5 | KMS, default encryption | SSE + CMK in Key Vault | Google-managed or CMEK |
| Encryption in transit | CC6.7 | A.8.24 | SC-8 | 4.2 | TLS policies, `aws:SecureTransport` | Min TLS 1.2, HTTPS only | SSL policies, `ssl_mode` |
| Network segmentation | CC6.6 | A.8.20, A.8.22 | SC-7 | 1.2-1.4 | VPCs, SGs, Network Firewall | VNets, NSGs, Azure Firewall | VPCs, firewall policies, VPC-SC |
| Vulnerability mgmt | CC7.1 | A.8.8 | RA-5, SI-2 | 6.3, 11.3 | Inspector, ECR scanning | Defender for Servers/Containers | Artifact Analysis, VM Manager |
| Threat detection | CC7.2 | A.8.16 | SI-4 | 10.4, 11.5 | GuardDuty, Security Hub | Defender for Cloud, Sentinel | SCC threat detection |
| Backup & DR | A1.2, A1.3 | A.8.13, A.5.30 | CP-9, CP-10 | 12.10 | AWS Backup + Vault Lock | Azure Backup, ASR | Backup and DR, multi-region |
| Change management | CC8.1 | A.8.32 | CM-3 | 6.5 | IaC + CI approvals, CloudFormation/Config history | IaC + Azure DevOps/GitHub approvals | IaC + Cloud Build approvals |
| Data residency | (privacy) | A.5.34 | — | — | SCP region deny | "Allowed locations" policy | `gcp.resourceLocations` org policy |

Treat control ids as starting points; confirm against the framework version in scope.

## Evidence collection (read-only)

Save evidence as files under `compliance/evidence/<yyyy-mm-dd>/` (ask before writing), one file per control, with the command used at the top. Never include secrets or personal data; redact account emails if required.

```bash
# MFA on root (AWS)
aws iam get-account-summary --query "SummaryMap.AccountMFAEnabled"
# Org trail
aws cloudtrail describe-trails --query "trailList[].{name:Name,multi:IsMultiRegionTrail,org:IsOrganizationTrail,validation:LogFileValidationEnabled,kms:KmsKeyId}"
# Azure diagnostic settings at subscription
az monitor diagnostic-settings subscription list -o table
# Azure Defender plans
az security pricing list --query "value[].{plan:name,tier:pricingTier}" -o table
# GCP audit config
gcloud projects get-iam-policy PROJECT --format=json | jq '.auditConfigs'
# GCP org policies in effect
gcloud org-policies list --project=PROJECT
```

## Gap report format

```
Framework: <name/version>   Scope: <accounts/subs/projects>   Date: <UTC>
| Control | Status | Evidence | Gap | Remediation (skill) | Owner |
| CIS 3.1 CloudTrail multi-region | Implemented | evidence/cloudtrail.json | — | — | — |
| CIS 1.14 Access keys rotated | Partial | evidence/cred-report-summary.txt | 3 keys > 90 days | secrets-and-identity | platform |
```

## Data and privacy notes

- Data residency: constrain regions with preventive controls (see `policy-as-code` table) and record approved regions in `CLOUD.md`.
- Classify data (`data-classification` tag) and apply stricter controls for `confidential`/`restricted` (CMEK, private networking, access logging, DLP: Macie, Purview, Sensitive Data Protection).
- Processing personal data with AI services: see `genai-platforms` (no training on customer data, region pinning, abuse monitoring settings).
