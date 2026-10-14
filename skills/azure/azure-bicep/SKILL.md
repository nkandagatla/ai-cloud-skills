---
name: azure-bicep
description: Author, review and deploy Azure Bicep/ARM safely - module structure, Azure Verified Modules, parameters files (.bicepparam), @secure() params and Key Vault references, linter configuration, what-if, incremental vs complete mode, Deployment Stacks with deny settings, deployment scopes, and troubleshooting failed deployments. Use when writing Bicep, reviewing ARM templates, or deploying Azure infrastructure as code.
---

# Azure Bicep

Load `cloud-guardrails`, `cloud-change-plan`, `iac-security-review`. Agents build, lint and run **what-if**. Deployments to nonprod after approval; prod via the pipeline. Complete mode is guard-blocked.

## 1. Structure

```
infra/
  main.bicep                 # orchestrates modules at the target scope
  main.dev.bicepparam
  main.prod.bicepparam
  modules/                   # local modules, or Azure Verified Modules (br/public:avm/...)
  bicepconfig.json           # linter rules as errors
```

Use **Azure Verified Modules** pinned to a version: `module kv 'br/public:avm/res/key-vault/vault:0.11.0' = { ... }`. Private registry (ACR) for internal modules.

`bicepconfig.json` (treat security rules as errors):

```json
{
  "analyzers": {
    "core": {
      "enabled": true,
      "rules": {
        "secure-parameter-default": { "level": "error" },
        "outputs-should-not-contain-secrets": { "level": "error" },
        "protect-commandtoexecute-secrets": { "level": "error" },
        "secure-secrets-in-params": { "level": "error" },
        "use-secure-value-for-secure-inputs": { "level": "error" },
        "no-hardcoded-env-urls": { "level": "error" },
        "no-hardcoded-location": { "level": "warning" },
        "use-recent-api-versions": { "level": "warning" },
        "no-unused-params": { "level": "warning" }
      }
    }
  }
}
```

## 2. Parameters and secrets

```bicep
@description('Administrator login for break-glass only; passwordless auth is primary.')
@secure()
param sqlAdminPassword string            // no default value, ever
```

`.bicepparam` reads from Key Vault at deploy time:

```bicep
using 'main.bicep'
param environment = 'prod'
param sqlAdminPassword = az.getSecret('<subscriptionId>', 'rg-secrets', 'kv-deploy-prod', 'sql-admin-password')
```

The deploying identity needs `Key Vault Secrets User` and the vault must have `enabledForTemplateDeployment` (access-policy model) or RBAC permission (RBAC model). Never output secrets; never use `listKeys()` in outputs (guard and linter both catch this).

## 3. Preview (always)

```bash
az bicep build --file main.bicep                       # compiles + lints
az bicep lint --file main.bicep
az deployment group what-if -g rg-orders-dev --template-file main.bicep --parameters main.dev.bicepparam \
  --result-format FullResourcePayloads   # or ResourceIdOnly for a summary
az deployment sub what-if -l eastus --template-file main.bicep --parameters main.dev.bicepparam     # subscription scope
```

Read the what-if: `Create`, `Modify` (property-level diff), `Delete` (only appears in Complete mode or stacks), `Deploy`, `NoChange`, `Ignore`. Note: what-if has known noise for some resource types (properties normalised by the RP); call out uncertain diffs instead of hiding them.

## 4. Deploy

```bash
az deployment group create -g rg-orders-dev --name orders-$(git rev-parse --short HEAD) \
  --template-file main.bicep --parameters main.dev.bicepparam --mode Incremental   # nonprod after approval
```

- Always **Incremental** mode (default). Complete mode deletes unmanaged resources in the RG (guard-blocked).
- Name deployments meaningfully (commit SHA); history keeps the last 800 per scope.
- For lifecycle management and protection prefer **Deployment Stacks**:

```bash
az stack group create --name orders-dev -g rg-orders-dev --template-file main.bicep --parameters main.dev.bicepparam \
  --action-on-unmanage detachAll --deny-settings-mode denyDelete --deny-settings-excluded-principals <pipeline-mi-object-id>
```

`--action-on-unmanage deleteAll` deletes resources removed from the template: guard asks; use `detachAll` unless deletion is the explicit intent and approved.

## 5. Troubleshooting failed deployments

```bash
az deployment group list -g RG --query "[?properties.provisioningState=='Failed'].{n:name,t:properties.timestamp}" -o table
az deployment operation group list -g RG --name DEPLOYMENT \
  --query "[?properties.provisioningState=='Failed'].{res:properties.targetResource.resourceName,type:properties.targetResource.resourceType,code:properties.statusMessage.error.code,msg:properties.statusMessage.error.message}" -o table
```

| Error code | Typical cause |
| --- | --- |
| `RequestDisallowedByPolicy` | An Azure Policy `deny`; fix the template to comply (see `azure-policy-governance`), do not request removal |
| `AuthorizationFailed` | Deploying identity lacks a role at scope (often role assignments need RBAC Administrator with conditions) |
| `InvalidTemplateDeployment` / `DeploymentFailed` | Inspect inner errors; API version/property names |
| `ResourceNotFound` on dependency | Missing `dependsOn` / wrong resource reference; use symbolic references |
| `ScopeLocked` | Resource lock; locks are intended, coordinate with the owner |
| `Conflict` / `AnotherOperationInProgress` | Concurrent deployment; wait and retry |
| `SkuNotAvailable` / quota | Region/zone capacity or quota (`azure-foundations`) |

## 6. ARM JSON

Treat like Bicep: `az bicep decompile` to convert for readability/review; same rules for `securestring`, outputs, and complete mode. Lint with PSRule for Azure / Checkov (`policy-as-code`).

## Never

- `--mode Complete`, stack `deleteAll` without explicit approval, deploying to prod from the agent.
- Defaults on `@secure()` params, secrets in `.bicepparam` literals, outputs or tags.
- Disable linter rules to pass the build.
