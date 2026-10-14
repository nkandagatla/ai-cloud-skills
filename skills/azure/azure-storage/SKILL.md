---
name: azure-storage
description: Secure and operate Azure Storage accounts - Blob/ADLS Gen2, Files, Queues, Tables - Entra ID auth and disabling shared keys, user-delegation SAS, private endpoints and network rules, encryption with CMK, soft delete/versioning/immutability, lifecycle management, replication (LRS/ZRS/GZRS), Defender for Storage, and troubleshooting 403s. Use for storage account creation, access, data protection or permission problems.
---

# Azure Storage

Load `cloud-guardrails`. Storage accounts hold data; never read or download blob contents unless the user asks for a specific object, and never print keys or connection strings (guard-blocked).

## 1. Account baseline

```hcl
resource "azurerm_storage_account" "this" {
  name                              = "stordersprodeus01"
  resource_group_name               = azurerm_resource_group.data.name
  location                          = var.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "ZRS"          # GZRS/RAGZRS for regional DR
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  shared_access_key_enabled         = false          # Entra ID only
  default_to_oauth_authentication   = true
  allow_nested_items_to_be_public   = false
  public_network_access_enabled     = false          # private endpoints
  infrastructure_encryption_enabled = true
  cross_tenant_replication_enabled  = false
  identity { type = "UserAssigned"  identity_ids = [azurerm_user_assigned_identity.storage_cmk.id] }
  customer_managed_key { key_vault_key_id = azurerm_key_vault_key.storage.versionless_id  user_assigned_identity_id = azurerm_user_assigned_identity.storage_cmk.id }
  blob_properties {
    versioning_enabled       = true
    change_feed_enabled      = true
    delete_retention_policy           { days = 14 }
    container_delete_retention_policy { days = 14 }
  }
  network_rules { default_action = "Deny"  bypass = ["AzureServices"] }
  tags = local.tags
  lifecycle { prevent_destroy = true }
}
```

Plus: private endpoints per sub-resource used (`blob`, `dfs`, `file`, `queue`, `table`) with private DNS zones; diagnostic settings (`StorageRead`, `StorageWrite`, `StorageDelete`) to Log Analytics for sensitive accounts; Defender for Storage (activity monitoring, malware scanning on upload, sensitive data threat detection); `CanNotDelete` lock on prod accounts.

Note: with `shared_access_key_enabled = false`, tools that only support keys (some older SDKs, Terraform data plane operations for containers unless `storage_use_azuread = true` in the provider) must be switched to Entra auth.

## 2. Access patterns

| Need | Pattern |
| --- | --- |
| App in Azure | Managed identity + `Storage Blob Data Reader/Contributor` scoped to the **container** |
| Humans | Entra group roles at container scope; portal uses Entra auth (`default_to_oauth_authentication`) |
| Temporary external share | **User delegation SAS** (signed with Entra credentials), short expiry, minimal permissions, HTTPS only, IP range if possible; never account SAS / service SAS from keys |
| Public static content | Front Door / CDN with private link origin, not public containers |
| Cross-tenant | Avoid; if needed, Entra B2B + RBAC; `cross_tenant_replication_enabled = false` |
| Hierarchical ACLs (ADLS Gen2) | RBAC for coarse access + POSIX ACLs for folders; ACLs assigned to groups |

## 3. Read-only discovery

```bash
az storage account list --subscription S --query "[].{n:name,rg:resourceGroup,kind:kind,sku:sku.name,tls:minimumTlsVersion,sharedKey:allowSharedKeyAccess,publicBlob:allowBlobPublicAccess,net:publicNetworkAccess,default:networkRuleSet.defaultAction}" -o table
az storage account show -n SA --query "{enc:encryption.keySource,infra:encryption.requireInfrastructureEncryption,https:enableHttpsTrafficOnly}"
az storage account blob-service-properties show -n SA -g RG --query "{versioning:isVersioningEnabled,softDelete:deleteRetentionPolicy,containerSoftDelete:containerDeleteRetentionPolicy,changeFeed:changeFeed.enabled}"
az storage container list --account-name SA --auth-mode login --query "[].{n:name,public:properties.publicAccess,immut:properties.hasImmutabilityPolicy,legal:properties.hasLegalHold}" -o table
az storage blob list --account-name SA -c CONTAINER --auth-mode login --prefix logs/2026/10/ --num-results 20 --query "[].{n:name,size:properties.contentLength,tier:properties.blobTier}" -o table
az storage account management-policy show -n SA -g RG
az graph query -q "resources | where type =~ 'microsoft.storage/storageaccounts' and (properties.allowBlobPublicAccess == true or properties.allowSharedKeyAccess != false or properties.minimumTlsVersion != 'TLS1_2') | project name, resourceGroup, subscriptionId"
```

Always use `--auth-mode login` for data-plane commands (never `--account-key` or connection strings).

## 4. Troubleshooting 403 / `AuthorizationPermissionMismatch`

1. Using Entra auth? (`--auth-mode login`; SDK `DefaultAzureCredential`).
2. Data-plane role (`Storage Blob Data *`) at the right scope (account/container); `Owner`/`Contributor` are not enough for data.
3. Role assignment propagation (up to ~10 min).
4. Network: `AuthorizationFailure` with network rules → client not on allowed VNet/private endpoint; private DNS resolves `*.privatelink.blob.core.windows.net` to the private IP?
5. `KeyBasedAuthenticationNotPermitted` → the client is using keys/SAS from keys; switch to Entra/user delegation SAS.
6. ADLS ACLs deny at a folder level.
7. CMK problems: key disabled/deleted or identity lost access → account inaccessible (alert a human immediately).

## 5. Data protection operations (changes)

| Operation | Safety |
| --- | --- |
| Delete blobs/containers | Soft delete and versioning allow recovery within retention; confirm exact paths; batch deletes need approval and a list |
| Restore | Undelete (`az storage blob undelete`), promote a previous version, or container restore (point-in-time restore for block blobs if enabled) |
| Immutability (WORM) | Time-based retention / legal hold; **locked** policies cannot be shortened or removed: human decision |
| Lifecycle rules | Deleting/tiering rules act on all matching blobs; review filters carefully; archive tier rehydration takes hours |
| Replication change (LRS→ZRS/GZRS) | Live migration request or conversion; plan for time and cost |
| Failover (GRS) | Customer-managed failover makes the secondary primary; possible data loss = last sync time; human decision |

## Never

- Enable public blob access, shared key access, weak TLS, or set network default action to Allow with public access (guard-blocked).
- List keys or connection strings, generate account SAS from keys (guard-blocked for keys).
- Delete storage accounts or remove locks/immutability from an agent.
- Copy production data to nonprod or local disks without a data-handling approval.
