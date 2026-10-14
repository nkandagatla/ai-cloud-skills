---
name: azure-aks
description: Build and operate Azure Kubernetes Service securely - Entra ID integration with Azure RBAC, local accounts disabled, private cluster/authorized IPs, workload identity, node pools and upgrades (auto-upgrade channels, node OS), Azure CNI Overlay/Cilium, network policies, Key Vault CSI, Azure Policy add-on, Defender for Containers, and troubleshooting. Use for AKS provisioning, upgrades, access, or cluster networking issues.
---

# Azure Kubernetes Service (AKS)

Load `cloud-guardrails` and use `kubernetes-ops` for in-cluster work.

## 1. Connect (read-only first)

```bash
az aks list --subscription S --query "[].{n:name,rg:resourceGroup,v:kubernetesVersion,private:apiServerAccessProfile.enablePrivateCluster,localAccounts:disableLocalAccounts,aad:aadProfile.managed}" -o table
az aks get-credentials -g RG -n AKS --context aks-<env>-<region>     # Entra-based kubeconfig; context name encodes env
kubelogin convert-kubeconfig -l azurecli
kubectl config current-context
```

`az aks get-credentials --admin` returns cluster-admin certificates: only for break-glass by humans (the guard asks; and with local accounts disabled it fails, as intended).

## 2. Secure cluster baseline

| Area | Setting |
| --- | --- |
| Identity | `--enable-aad --enable-azure-rbac --disable-local-accounts`; humans via Entra groups with `Azure Kubernetes Service RBAC Reader/Writer` scoped to namespaces; cluster admin only via PIM |
| API server | Private cluster or API server VNet integration, or `--api-server-authorized-ip-ranges` (never open to all in prod) |
| Workloads | `--enable-oidc-issuer --enable-workload-identity`; UAMI per app with federated credential `system:serviceaccount:<ns>:<sa>` |
| Secrets | Azure Key Vault Secrets Provider add-on (CSI) with workload identity; etcd encryption with KMS (`--enable-azure-keyvault-kms`) for regulated workloads |
| Network | Azure CNI Overlay powered by Cilium (network policies built in) or Azure CNI + Calico; egress via `userDefinedRouting` to Azure Firewall or managed NAT gateway |
| Policy | Azure Policy add-on (Gatekeeper) with "Kubernetes cluster pod security restricted standards" initiative; Image Integrity for signed images |
| Nodes | System and user node pools separated (`CriticalAddonsOnly` taint on system); Azure Linux or Ubuntu; node OS auto-upgrade `NodeImage`/`SecurityPatch`; ephemeral OS disks; availability zones |
| Upgrades | Auto-upgrade channel `patch` (or `stable`) + planned maintenance windows; LTS only when needed |
| Monitoring | Container Insights (AMA), Managed Prometheus + Managed Grafana, diagnostic settings for `kube-audit-admin`, `kube-apiserver`, `guard` |
| Detection | Defender for Containers (runtime, vulnerability assessment, K8s API audit) |
| Registry | ACR attached via `AcrPull` to kubelet identity; private endpoint; admin user off |
| Tier | Standard tier (uptime SLA) for prod |

Terraform excerpt (azurerm 4.x; check argument names against your provider version):

```hcl
resource "azurerm_kubernetes_cluster" "this" {
  name                      = "aks-platform-prod-eastus-01"
  location                  = var.location
  resource_group_name       = azurerm_resource_group.aks.name
  dns_prefix                = "aks-platform-prod"
  sku_tier                  = "Standard"
  private_cluster_enabled   = true
  local_account_disabled    = true
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
  azure_policy_enabled      = true
  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    admin_group_object_ids = [var.aks_admin_group_id]   # PIM-eligible group
  }
  default_node_pool {
    name                         = "system"
    vm_size                      = "Standard_D4ds_v5"
    zones                        = ["1", "2", "3"]
    only_critical_addons_enabled = true
    os_disk_type                 = "Ephemeral"
    vnet_subnet_id               = var.nodes_subnet_id
    auto_scaling_enabled         = true
    min_count                    = 3
    max_count                    = 5
    upgrade_settings { max_surge = "33%" }
  }
  identity { type = "UserAssigned"  identity_ids = [azurerm_user_assigned_identity.aks.id] }
  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    outbound_type       = "userDefinedRouting"
  }
  key_vault_secrets_provider { secret_rotation_enabled = true }
  microsoft_defender { log_analytics_workspace_id = var.law_id }
  oms_agent { log_analytics_workspace_id = var.law_id, msi_auth_for_monitoring_enabled = true }
  maintenance_window_auto_upgrade { frequency = "Weekly", interval = 1, duration = 4, day_of_week = "Sunday", start_time = "02:00", utc_offset = "+00:00" }
  tags = local.tags
}
```

## 3. Workload identity for an app

```bash
# platform/IaC: UAMI + role on the resource + federated credential
az identity federated-credential create --name orders-api --identity-name id-orders-api-prod -g RG \
  --issuer "$(az aks show -g RG -n AKS --query oidcIssuerProfile.issuerUrl -o tsv)" \
  --subject system:serviceaccount:orders:orders-api --audiences api://AzureADTokenExchange
```

ServiceAccount annotation `azure.workload.identity/client-id: <uami-client-id>` and pod label `azure.workload.identity/use: "true"`.

## 4. Upgrades

1. `az aks get-upgrades -g RG -n AKS -o table`; check deprecated APIs (`kubent`/`pluto`, AKS diagnose and solve "Kubernetes API deprecations").
2. Nonprod first. Control plane then node pools (`az aks upgrade --control-plane-only`, then `az aks nodepool upgrade`), via IaC or a reviewed change.
3. Surge settings and PDBs; watch `kubectl get nodes -w` and workload health.
4. Node image updates separately (`az aks nodepool upgrade --node-image-only`).

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| `kubectl` asks for login repeatedly / 403 | kubelogin mode, Entra group membership, Azure RBAC role at cluster/namespace scope |
| Cannot reach API (private cluster) | Run from a VNet-connected jump host / `az aks command invoke` (runs in cluster; treat as exec, needs approval), private DNS zone linked |
| Pods can't pull from ACR | `az aks check-acr -g RG -n AKS --acr ACR.azurecr.io` (diagnostic), kubelet identity `AcrPull`, ACR private endpoint DNS |
| Workload identity token errors | SA annotation/label, federated credential subject/issuer exact match, UAMI role assignments, propagation delay |
| Egress failures | UDR to firewall, firewall application rules for required AKS FQDNs (`AzureKubernetesService` tag) |
| Node NotReady | `az aks show --query agentPoolProfiles`, node events, VMSS instance health, AKS diagnose and solve |

## Never

- Enable local accounts, use `--admin` credentials routinely, or open the API server to all IPs in prod.
- Disable the Azure Policy add-on or switch policies to audit to deploy a non-compliant workload.
- Give kubelet/control-plane identities broad roles (Contributor on subscription).
- Delete clusters or node pools in prod from the agent (`az aks delete` asks; prod denies).
