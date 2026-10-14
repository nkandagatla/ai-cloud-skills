---
name: azure-key-vault
description: Azure Key Vault and Managed HSM - RBAC authorization mode, network isolation, soft delete and purge protection, secrets/keys/certificates lifecycle, rotation policies and near-expiry events, Key Vault references, CMK for other services, and troubleshooting access. Use when creating or reviewing vaults, granting access to secrets, rotation, certificates, or Key Vault errors.
---

# Azure Key Vault

Load `cloud-guardrails` and `secrets-and-identity`. Agents manage vaults and access **metadata**; they never read secret values, download keys/certificates, delete or purge anything (guard-blocked).

## 1. Vault baseline

```bicep
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-orders-prod-eus-01'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }        // 'premium' for HSM-backed keys
    enableRbacAuthorization: true                  // no access policies
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true                    // irreversible once enabled: intended
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}
```

Plus private endpoint + `privatelink.vaultcore.azure.net` DNS; diagnostic settings (`AuditEvent`) to Log Analytics; `CanNotDelete` lock; Defender for Key Vault; one vault per app per environment (vaults are the RBAC boundary for secrets unless you assign per secret).

## 2. Access (RBAC mode)

| Who | Role | Scope |
| --- | --- | --- |
| App reading secrets | `Key Vault Secrets User` | vault, or individual secret |
| App using a key (wrap/unwrap, sign) | `Key Vault Crypto User` / `Key Vault Crypto Service Encryption User` (for CMK on services) | key |
| CI writing secrets (rare) | `Key Vault Secrets Officer` | vault, via PIM/approval |
| Certificate automation | `Key Vault Certificates Officer` | vault |
| Platform admin | `Key Vault Administrator` | via PIM, time-bound |
| Auditors | `Key Vault Reader` (metadata only) | vault |

Data-plane roles are separate from `Owner`/`Contributor`. Contributors can change network rules and RBAC-mode settings: restrict who has control-plane write on vaults.

## 3. Lifecycle

- **Secrets**: set expiry (`exp`) and `nbf`; content type; rotate on schedule. Event Grid `Microsoft.KeyVault.SecretNearExpiry` → Function/Logic App that rotates (e.g. regenerates a credential at the source and writes a new version). Consumers reference versionless URIs and re-read periodically.
- **Keys**: rotation policy (`az keyvault key rotation-policy update`) with auto-rotate + notify before expiry; RSA 3072+/EC P-256+; HSM-backed for high assurance (Premium / Managed HSM); CMK consumers (Storage, SQL TDE, Disk Encryption Sets) use versionless key ids for auto-rotation.
- **Certificates**: issued via integrated CA (DigiCert/GlobalSign) or ACME automation; lifetime action `AutoRenew` at 80% of lifetime; App Gateway/App Service/Front Door reference versionless secret ids.

## 4. Read-only inspection (never values)

```bash
az keyvault list --subscription S --query "[].{n:name,rg:resourceGroup}" -o table
az keyvault show -n KV --query "{rbac:properties.enableRbacAuthorization,softDelete:properties.enableSoftDelete,purgeProt:properties.enablePurgeProtection,retention:properties.softDeleteRetentionInDays,public:properties.publicNetworkAccess,default:properties.networkAcls.defaultAction}"
az keyvault secret list --vault-name KV --query "[].{n:name,enabled:attributes.enabled,expires:attributes.expires,updated:attributes.updated}" -o table
az keyvault key list --vault-name KV --query "[].{n:name,kty:kty,enabled:attributes.enabled,expires:attributes.expires}" -o table
az keyvault key rotation-policy show --vault-name KV -n KEY
az keyvault certificate list --vault-name KV --query "[].{n:name,expires:attributes.expires,enabled:attributes.enabled}" -o table
az role assignment list --scope $(az keyvault show -n KV --query id -o tsv) --query "[].{who:principalName,role:roleDefinitionName}" -o table
az keyvault list-deleted --query "[].{n:name,scheduledPurge:properties.scheduledPurgeDate}" -o table
```

`az keyvault secret show` returns the value: never use it (guard-blocked).

## 5. Troubleshooting

| Error | Cause |
| --- | --- |
| `Forbidden` / `ForbiddenByRbac` | Missing data-plane role, wrong scope, propagation delay; caller identity (check managed identity client id used by the app) |
| `ForbiddenByFirewall` / `Client address is not authorized` | Network ACL / private endpoint; DNS resolving to public IP; trusted services bypass not applicable to that service |
| `SecretNotFound` but secret exists | Wrong vault (env), soft-deleted (recover with `az keyvault secret recover`: change), version id pinned to old version |
| App setting Key Vault reference error | See `azure-app-service-functions` |
| CMK service outage (Storage/SQL inaccessible) | Key disabled/expired/deleted or identity lost `Crypto Service Encryption User`: **critical**, page a human; recover key from soft delete |
| Name already in use after deletion | Vault is soft-deleted (names are global); recover it rather than purge |

## Never

- `secret show/download`, `key download/backup/decrypt`, `certificate download` (guard-blocked): reference secrets from workloads instead.
- Delete or purge vaults, keys, secrets or certificates (guard-blocked); disable purge protection (not possible) or set network default to Allow (guard-blocked).
- Switch a vault from RBAC to access policies, or grant `Key Vault Administrator` permanently.
- Write secret values in IaC (`azurerm_key_vault_secret` with literal `value` ends up in state): generate in-service or set by a human / ephemeral resource.
