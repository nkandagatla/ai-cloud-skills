---
name: gcp-gke
description: Build and operate Google Kubernetes Engine securely - Autopilot vs Standard, private clusters and control-plane access, Workload Identity Federation for GKE, Google Groups for RBAC, release channels and maintenance windows, node pools (Shielded, COS, auto-upgrade), Dataplane V2 network policy, Binary Authorization, Security Posture, Backup for GKE, and troubleshooting. Use for GKE provisioning, upgrades, access, or cluster networking issues.
---

# Google Kubernetes Engine (GKE)

Load `cloud-guardrails` and use `kubernetes-ops` for in-cluster work.

## 1. Connect (read-only first)

```bash
gcloud container clusters list --project=P --format="table(name,location,currentMasterVersion,releaseChannel.channel,autopilot.enabled,privateClusterConfig.enablePrivateNodes)"
gcloud container clusters get-credentials CLUSTER --location=R --project=P      # uses gke-gcloud-auth-plugin, no static creds
kubectl config rename-context gke_P_R_CLUSTER gke-<env>-<region>               # make env visible in the context name
kubectl config current-context
```

For private endpoints: connect from an authorized network, via a bastion with IAP, or use **DNS-based control-plane endpoint** with IAM-based access.

## 2. Secure cluster baseline

| Area | Setting |
| --- | --- |
| Mode | **Autopilot** by default (hardened, node management handled); Standard only when you need node-level control |
| Control plane | Private endpoint or DNS-based endpoint; **master authorized networks** if IP-based; no `0.0.0.0/0` |
| Nodes | Private nodes (no external IPs), Shielded GKE nodes, Container-Optimized OS (containerd), secure boot, auto-repair and auto-upgrade, dedicated node SA with minimal roles (`roles/container.defaultNodeServiceAccount`) |
| Identity | **Workload Identity Federation for GKE** (`workload_pool = "P.svc.id.goog"`); grant IAM directly to `principal://iam.googleapis.com/projects/NUM/locations/global/workloadIdentityPools/P.svc.id.goog/subject/ns/NS/sa/KSA` or via a GSA |
| Human access | **Google Groups for RBAC** (`gke-security-groups@domain`), Kubernetes RBAC bound to groups; IAM `roles/container.clusterViewer` / `developer` scoped carefully; no legacy ABAC, no basic auth/client certs |
| Network | VPC-native (alias IPs), **Dataplane V2** (eBPF, network policy built in), network policies default-deny, Cloud NAT for egress |
| Secrets | Application-layer secrets encryption (Cloud KMS) + Secret Manager add-on / CSI |
| Supply chain | Artifact Registry with vulnerability scanning; **Binary Authorization** (require attestations) |
| Posture | GKE Security Posture (workload config audit, vulnerability scanning), Threat Detection (SCC Container Threat Detection) |
| Upgrades | **Release channel** (`REGULAR` or `STABLE`) + maintenance windows/exclusions; surge or blue-green node upgrades |
| Observability | Cloud Logging/Monitoring with system + workload logs, Managed Service for Prometheus, control plane logs for audit |
| DR | Backup for GKE plans for stateful namespaces |

Terraform sketch (Autopilot):

```hcl
resource "google_container_cluster" "this" {
  name             = "gke-prod-usc1"
  location         = "us-central1"
  project          = var.project_id
  enable_autopilot = true
  network          = var.network_self_link
  subnetwork       = var.subnet_self_link
  ip_allocation_policy { cluster_secondary_range_name = "pods", services_secondary_range_name = "services" }
  private_cluster_config { enable_private_nodes = true, enable_private_endpoint = true, master_ipv4_cidr_block = "172.16.0.32/28" }
  master_authorized_networks_config { cidr_blocks { cidr_block = var.admin_cidr, display_name = "admin-vpc" } }
  release_channel { channel = "REGULAR" }
  authenticator_groups_config { security_group = "gke-security-groups@acme.com" }
  binary_authorization { evaluation_mode = "PROJECT_SINGLETON_POLICY_ENFORCE" }
  database_encryption { state = "ENCRYPTED", key_name = var.kms_key_id }
  maintenance_policy { recurring_window { start_time = "2026-01-04T02:00:00Z", end_time = "2026-01-04T06:00:00Z", recurrence = "FREQ=WEEKLY;BYDAY=SA,SU" } }
  deletion_protection = true
  resource_labels     = local.labels
}
```

(Verify argument names against your provider version; Autopilot enables Workload Identity, Shielded nodes and Dataplane V2 by default.)

## 3. Workload identity for an app

```hcl
resource "google_project_iam_member" "orders_reader" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "principal://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/orders/sa/orders-api"
}
```

Prefer resource-level bindings (topic/subscription/bucket/secret) over project-level.

## 4. Upgrades

1. Check upgrade insights / deprecation notices (`gcloud container clusters describe --format="value(currentMasterVersion)"`, GKE deprecation insights in Recommender).
2. Release channel handles auto-upgrades; use **maintenance exclusions** around freezes rather than leaving channels.
3. For manual upgrades in Standard: nonprod first; control plane then node pools; surge settings; PDBs respected.

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| `kubectl` unauthorized | `gke-gcloud-auth-plugin` installed, IAM role on project, Google Groups for RBAC membership + RoleBinding |
| Pods `Pending` (Autopilot) | Resource requests vs Autopilot minimums/ratios, compute class availability, quotas |
| Workload identity 403 | KSA namespace/name in principal, IAM binding on right resource, metadata server (`169.254.169.254`) reachable, WI enabled on node pool (Standard) |
| Image pull errors | Artifact Registry IAM for node SA / Autopilot default, region, private Google Access, Binary Authorization denial (events show `Denied by ... policy`) |
| Network policy blocks | Dataplane V2 network policy logging, DNS egress allowed |
| Ingress/Gateway not ready | Health checks (firewall for `35.191.0.0/16`, `130.211.0.0/22`), NEG status, backend config |

## Never

- Public control-plane endpoint without authorized networks in prod; legacy ABAC; basic auth; client certificates.
- Default compute SA on node pools, or broad roles (Editor) on node SAs.
- Disable Binary Authorization or set it to dry-run to push an unsigned image.
- Delete clusters (`deletion_protection` stays true) or node pools in prod from the agent.
