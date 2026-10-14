---
name: gcp-org-policy-security
description: Google Cloud organization governance and security posture - Organization Policy constraints (managed and custom), dry-run policies, VPC Service Controls perimeters, Security Command Center (findings, posture, mute rules), org-level audit log sinks and log buckets, Access Transparency, Assured Workloads. Use when writing or reviewing org policies or perimeters, triaging SCC findings, or auditing org security posture.
---

# GCP Org Policy and Security

Load `cloud-guardrails`. Org- and folder-level changes affect every project below. Agents read, design and review; changes ship through the landing-zone IaC pipeline. The guard blocks disabling/deleting org policies, perimeters, log sinks, SCC notifications and audit-relevant services.

## 1. Read current state

```bash
gcloud org-policies list --organization=ORG
gcloud org-policies describe constraints/iam.allowedPolicyMemberDomains --organization=ORG
gcloud org-policies list --project=P --show-unset=false
gcloud org-policies describe compute.vmExternalIpAccess --project=P --effective
gcloud access-context-manager perimeters list --policy=POLICY_ID --format="table(name,title,status.resources.len(),spec.resources.len())"
gcloud access-context-manager perimeters describe PERIMETER --policy=POLICY_ID
gcloud logging sinks list --organization=ORG --format="table(name,destination,filter,includeChildren)"
gcloud scc findings list organizations/ORG --filter='state="ACTIVE" AND severity="CRITICAL"' --limit=50 --format="table(finding.category,finding.resourceName,finding.eventTime)"
```

## 2. Baseline org policy set (start in dry-run)

| Constraint | Setting | Why |
| --- | --- | --- |
| `iam.allowedPolicyMemberDomains` (or managed `iam.managed.allowedPolicyMembers`) | Your Workspace/Cloud Identity customer id | Blocks `allUsers` and foreign domains in IAM |
| `iam.managed.disableServiceAccountKeyCreation` / `iam.disableServiceAccountKeyUpload` | Enforced | No long-lived SA keys |
| `iam.automaticIamGrantsForDefaultServiceAccounts` | Enforced | Default SAs don't get Editor |
| `storage.publicAccessPrevention` | Enforced | No public buckets |
| `storage.uniformBucketLevelAccess` | Enforced | No object ACLs |
| `compute.vmExternalIpAccess` | Deny all (allow-list exceptions) | No public IPs on VMs |
| `compute.requireOsLogin` | Enforced | IAM-controlled SSH |
| `compute.requireShieldedVm` | Enforced | Secure boot/vTPM |
| `compute.skipDefaultNetworkCreation` | Enforced | No auto-mode default VPC with open firewall rules |
| `compute.restrictVpcPeering`, `compute.restrictSharedVpcHostProjects` | Allow-list | Network sprawl control |
| `sql.restrictPublicIp`, `sql.restrictAuthorizedNetworks` | Enforced | Private Cloud SQL |
| `gcp.resourceLocations` | e.g. `in:us-locations` / `in:eu-locations` | Data residency |
| `gcp.restrictNonCmekServices` / `gcp.restrictCmekCryptoKeyProjects` | Where CMEK is required | Key ownership |
| `essentialcontacts.allowedContactDomains` | Your domains | Notifications stay internal |
| `run.allowedIngress` | `internal-and-cloud-load-balancing` | No direct public Cloud Run |
| `cloudfunctions.allowedIngressSettings` | Internal / LB | Same for functions |

Custom constraints (CEL on resource fields) for anything not covered, e.g. require GKE private nodes or deny buckets without a label.

```yaml
# custom constraint example
name: organizations/ORG/customConstraints/custom.gkeRequirePrivateNodes
resourceTypes: [container.googleapis.com/Cluster]
methodTypes: [CREATE, UPDATE]
condition: "resource.privateClusterConfig.enablePrivateNodes == true"
actionType: ALLOW
displayName: GKE clusters must use private nodes
```

Rollout: **dry-run** spec (`dryRunSpec` in the policy) → review violations in Policy Intelligence / logs (`orgpolicy` dry-run audit entries) for 1-2 weeks → enforce at sandbox folder → nonprod → prod. Exceptions are scoped to specific projects with documented reasons and review dates.

## 3. VPC Service Controls

- Perimeters around projects holding sensitive data (BigQuery, GCS, Secret Manager, Cloud SQL, Vertex AI...), restricted services list, **VPC accessible services**.
- Access levels (corp IP ranges, device policy) and **ingress/egress rules** for specific identities and projects instead of broad bridges.
- Always roll out with **dry-run perimeter** (`spec` vs `status`), analyse `VPC_SERVICE_CONTROLS` violations in logs, then enforce. A wrong enforced perimeter breaks production pipelines instantly.
- Use `restricted.googleapis.com` VIP with Private Google Access for perimeter workloads.

## 4. Logging and evidence

- Org-level **aggregated sink** (`includeChildren=true`) of audit logs to a central log bucket (locked retention) and/or BigQuery for analysis.
- Data Access audit logs on for sensitive services (BigQuery, Secret Manager, GCS for sensitive buckets, Cloud SQL) at org/folder level; mind cost.
- Access Transparency / Access Approval for regulated workloads.
- Log bucket **locked retention** (cannot be reduced): a one-way decision for humans.

## 5. Security Command Center

- Tier: Standard / Premium / Enterprise; built-in detectors (Security Health Analytics, Event/Container/VM Threat Detection, Web Security Scanner), attack path simulation, compliance reports (`cloud-compliance-mapping`).
- **Security posture** service: define postures (bundled org policies + SHA detectors), deploy to org/folders, detect drift.
- Mute rules only for documented accepted risk, scoped narrowly (guard blocks agents creating mute configs); never mute whole categories.
- Notifications to Pub/Sub → automation (`gcp-security-automation`) / SIEM.

Triage output:

```
Org: acme.com  SCC tier: Premium  Active findings: CRITICAL 4, HIGH 37
| Category | Count | Example resource | Fix (skill) |
| PUBLIC_BUCKET_ACL | 2 | //storage.googleapis.com/acme-legacy-exports | gcp-cloud-storage |
| OPEN_FIREWALL | 6 | fw allow-ssh-all (proj acme-dev) | gcp-networking |
```

## Never

- Disable/delete org policies, reset them to allow, delete perimeters or switch them to dry-run, delete log sinks or buckets, mute SCC findings (guard-blocked).
- Enforce new perimeters or deny constraints in prod without a dry-run period.
- Add broad exceptions (`allowAll`) to fix one project; scope to that project with a review date.
