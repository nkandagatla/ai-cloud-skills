---
name: azure-app-service-functions
description: Secure and operate Azure App Service (Web Apps) and Azure Functions - plans (Flex Consumption, Premium, Dedicated), managed identity, Key Vault references, VNet integration and private endpoints, deployment slots and zero-downtime swaps, Easy Auth, TLS/FTPS settings, App Insights, scaling and troubleshooting. Use for web app or function deployments, configuration, or runtime errors on Azure.
---

# Azure App Service and Functions

Load `cloud-guardrails`. Deploy through CI with deployment slots; production swaps are pipeline/human actions.

## 1. Secure baseline (both)

| Setting | Value |
| --- | --- |
| HTTPS only | `httpsOnly: true` |
| Minimum TLS | `minTlsVersion: '1.2'` (1.3 where supported); `scmMinTlsVersion: '1.2'` |
| FTP | `ftpsState: 'Disabled'` (FTPS only if unavoidable; `AllAllowed` is guard-blocked) |
| Basic auth publishing | Disabled for FTP and SCM (`basicPublishingCredentialsPolicies` ftp/scm `allow: false`) |
| Identity | System- or user-assigned managed identity |
| Secrets | **Key Vault references** in app settings: `@Microsoft.KeyVault(SecretUri=https://kv-orders-prod.vault.azure.net/secrets/db-conn/)` with `keyVaultReferenceIdentity` set; better, passwordless connections (Entra auth to SQL, Storage, Service Bus) |
| Network inbound | Private endpoint + `publicNetworkAccess: Disabled` for internal apps; for public apps: Front Door/App Gateway WAF in front + access restrictions allowing only `AzureFrontDoor.Backend` with `X-Azure-FDID` header |
| Network outbound | Regional VNet integration with `vnetRouteAllEnabled: true` and NAT/firewall |
| SCM site | Access restrictions on `scm` too (`scmIpSecurityRestrictionsUseMain` or explicit) |
| Auth | Easy Auth (App Service Authentication) with Entra ID, or app-level OIDC; `unauthenticatedClientAction: RedirectToLoginPage/Return401` |
| Platform | Supported runtime stack versions; `alwaysOn` for Dedicated/Premium; `http20Enabled`; remote debugging off; client certs where required |
| Monitoring | Application Insights (connection string in app settings is not a secret, but keep it out of public repos); diagnostic settings for `AppServiceHTTPLogs`, `AppServiceConsoleLogs`, `AppServiceAuditLogs` |
| Resilience | Zone redundancy (Premium v3/Elastic Premium), ≥ 3 instances for prod, health check path configured |

Functions specifics: **Flex Consumption** for most new apps (VNet integration, per-function scaling, managed identity for the deployment storage); storage account access via managed identity (`AzureWebJobsStorage__accountName` + identity, not connection string with keys); function keys are not user authentication: put APIM / Easy Auth in front for public HTTP triggers; `authLevel` `function` minimum for HTTP triggers.

## 2. Deployment slots and zero-downtime

1. Deploy to `staging` slot (zip deploy / container image by digest / run-from-package).
2. Slot-specific (sticky) settings for environment-specific values (`slotSetting: true`).
3. Warm-up (`applicationInitialization`, health check) and smoke tests on the staging slot URL.
4. **Swap with preview** (`az webapp deployment slot swap --action preview`, then `--action swap`) through the pipeline; rollback = swap back.

```bash
az webapp deployment slot list -g RG -n APP -o table
az webapp deployment slot swap -g RG -n APP --slot staging --target-slot production --action preview   # change: pipeline/human for prod
```

## 3. Read-only operations

```bash
az webapp list --subscription S --query "[].{n:name,rg:resourceGroup,state:state,https:httpsOnly,plan:appServicePlanId}" -o table
az webapp show -g RG -n APP --query "{https:httpsOnly,tls:siteConfig.minTlsVersion,ftps:siteConfig.ftpsState,public:publicNetworkAccess,identity:identity.type,vnet:virtualNetworkSubnetId}"
az webapp config appsettings list -g RG -n APP --query "[].name" -o tsv      # NAMES only; values may contain secrets
az webapp config access-restriction show -g RG -n APP
az webapp log tail -g RG -n APP          # streams live logs; may contain sensitive data
az functionapp list --query "[].{n:name,rg:resourceGroup,kind:kind,state:state}" -o table
az functionapp function list -g RG -n FUNC --query "[].{n:name,trigger:config.bindings[0].type}" -o table
az monitor app-insights query --app AI_NAME -g RG --analytics-query "requests | where timestamp > ago(1h) | summarize count(), failures=countif(success==false), p95=percentile(duration,95) by name | order by failures desc"
```

Never list app setting **values** or connection strings (`appsettings list` without `--query "[].name"`, `config connection-string list`), publishing profiles or function keys (guard-blocked).

## 4. Troubleshooting

| Symptom | Check |
| --- | --- |
| 503 / app not starting | Log stream/console logs, container logs (`az webapp log download` to a local gitignored path), startup command, port (`WEBSITES_PORT`) |
| Key Vault reference shows error | Identity has `Key Vault Secrets User`, vault networking allows app (VNet integration + private endpoint or trusted services), reference syntax, `keyVaultReferenceIdentity` |
| Cannot reach private resources | VNet integration subnet, `vnetRouteAllEnabled`, private DNS zones linked to the integration VNet |
| Function not triggering | Host storage access (identity roles: Storage Blob Data Owner, Queue Data Contributor as required), trigger connection settings, scale controller logs, Flex Consumption instance limits |
| Cold starts | Premium/Flex always-ready instances (cost), smaller packages |
| Slot swap failed | Warm-up failing on staging, sticky setting differences |

Restarting an app (`az webapp restart`) is a change (brief outage); ask first and record.

## Never

- Enable FTP/basic publishing credentials, download publishing profiles, or print app setting values/function keys (guard-blocked).
- Put secrets directly in app settings when Key Vault references or passwordless auth are possible.
- Deploy directly to the production slot of a prod app.
- Expose HTTP-triggered functions anonymously without an upstream auth layer.
