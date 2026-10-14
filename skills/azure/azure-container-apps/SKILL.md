---
name: azure-container-apps
description: Deploy and operate Azure Container Apps and Azure Container Registry securely - environments with VNet integration and internal ingress, managed identity image pulls, Key Vault secret references, revisions and traffic splitting, KEDA scaling, Dapr, jobs, and troubleshooting. Use for container deployments on Container Apps, ACR configuration, or revision/scaling issues.
---

# Azure Container Apps and ACR

Load `cloud-guardrails` and `container-supply-chain`.

## 1. Environment baseline

- **Workload profiles** environment with **custom VNet** (dedicated subnet, delegated); `internal: true` for private apps (ingress only via the VNet / App Gateway / Front Door private link).
- Egress through UDR to Azure Firewall or NAT gateway (workload profiles support UDR).
- Log Analytics or Azure Monitor (diagnostic settings) for console/system logs; OpenTelemetry agent for traces.
- Zone redundancy for prod environments.
- mTLS between apps (peer authentication) if required; Dapr with scoped components.

## 2. App baseline

```bicep
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-orders-api-prod'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${uami.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: { external: false, targetPort: 8080, transport: 'auto', allowInsecure: false,
                 traffic: [ { latestRevision: true, weight: 100 } ] }
      registries: [ { server: '${acrName}.azurecr.io', identity: uami.id } ]          // no username/password
      secrets: [ { name: 'db-conn', keyVaultUrl: 'https://kv-orders-prod.vault.azure.net/secrets/db-conn', identity: uami.id } ]
    }
    template: {
      containers: [ {
        name: 'api'
        image: '${acrName}.azurecr.io/orders-api@sha256:${digest}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [ { name: 'DB_CONN', secretRef: 'db-conn' }, { name: 'AZURE_CLIENT_ID', value: uami.properties.clientId } ]
        probes: [ { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 } }, { type: 'Liveness', httpGet: { path: '/livez', port: 8080 } } ]
      } ]
      scale: { minReplicas: 2, maxReplicas: 20, rules: [ { name: 'http', http: { metadata: { concurrentRequests: '50' } } } ] }
    }
  }
}
```

Prefer passwordless (managed identity) access to data services over secret connection strings.

## 3. ACR baseline

Premium SKU for private endpoints and CMK; `adminUserEnabled: false` (enabling is guard-blocked); `anonymousPullEnabled: false`; `publicNetworkAccess: Disabled` with private endpoint (plus trusted services for ACR Tasks if used); Defender for Containers scanning; retention policy for untagged manifests; artifact cache rules for upstream images; `AcrPull` / `AcrPush` roles to identities only. Repository-scoped tokens are a last resort.

## 4. Revisions and rollout

- `activeRevisionsMode: Multiple` → deploy new revision with 0% traffic, test via revision label URL, shift traffic gradually (10% → 50% → 100%), keep previous revision active for quick rollback.

```bash
az containerapp revision list -g RG -n APP --query "[].{n:name,active:properties.active,traffic:properties.trafficWeight,health:properties.healthState,created:properties.createdTime}" -o table
az containerapp ingress traffic set -g RG -n APP --revision-weight ca-orders-api-prod--v42=10 ca-orders-api-prod--v41=90   # change
az containerapp ingress traffic set -g RG -n APP --revision-weight ca-orders-api-prod--v41=100                           # rollback
```

## 5. Read-only troubleshooting

```bash
az containerapp show -g RG -n APP --query "{fqdn:properties.configuration.ingress.fqdn,external:properties.configuration.ingress.external,latest:properties.latestRevisionName,running:properties.runningStatus}"
az containerapp replica list -g RG -n APP --revision REV -o table
az containerapp logs show -g RG -n APP --type system --tail 50
az containerapp logs show -g RG -n APP --type console --tail 100
az containerapp env show -g RG -n ENV --query "{vnet:properties.vnetConfiguration,internal:properties.vnetConfiguration.internal,zr:properties.zoneRedundant}"
az acr repository show-tags -n ACR --repository orders-api --orderby time_desc --top 5 -o table
```

| Symptom | Check |
| --- | --- |
| Revision `Unhealthy` / provisioning failed | System logs: image pull (identity has `AcrPull`, ACR private DNS from the environment VNet), probe failures, port mismatch |
| Key Vault secret reference fails | Identity has `Key Vault Secrets User`, vault network access from environment |
| Scale not happening | KEDA rule metadata, scaler auth (managed identity for Service Bus/Event Hubs), min/max replicas |
| 404 from ingress | Internal vs external ingress, custom domain bindings, traffic weights pointing to an inactive revision |

`az containerapp exec` opens a shell in a running replica: approval needed, never in prod without an incident reason.

## Never

- Use ACR admin credentials or registry passwords in app configuration (guard-blocked for enabling admin user).
- Deploy by mutable tag (`:latest`) to prod.
- Make internal apps external to debug; use revision labels from inside the VNet.
- Store secrets as plain Container Apps secrets when a Key Vault reference works.
