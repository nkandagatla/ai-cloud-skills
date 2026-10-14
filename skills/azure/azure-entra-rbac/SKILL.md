---
name: azure-entra-rbac
description: Azure identity and access - Entra ID users/groups/apps/service principals, managed identities, workload identity federation, Azure RBAC role assignments and custom roles, PIM, Conditional Access, data-plane roles, and troubleshooting AuthorizationFailed. Use for role assignments, app registrations, managed identity setup, access reviews, or permission errors on Azure.
---

# Azure Entra ID and RBAC

Load `cloud-guardrails` and `secrets-and-identity`. Identity changes are security changes: IaC, review, least privilege. The guard blocks Owner/User Access Administrator assignments, client secret creation and high-privilege Graph permissions.

## 1. Two permission systems

- **Azure RBAC** (Azure Resource Manager): role assignments = principal + role definition + scope (management group / subscription / resource group / resource). Additive; deny assignments are rare (blueprints/stacks/managed apps).
- **Entra ID roles** (directory): Global Administrator, Application Administrator, etc. Managed via PIM; agents never assign these.
- **Data plane** is separate: e.g. `Storage Blob Data Reader`, `Key Vault Secrets User`, `Cosmos DB Built-in Data Reader` (Cosmos uses its own SQL role assignments). `Contributor` does not grant blob/secret data access when RBAC data access is used.

## 2. Least-privilege role choice

| Need | Use | Avoid |
| --- | --- | --- |
| Read everything for audit | `Reader` + `Security Reader` | `Contributor` |
| Deploy one app's resources | `Contributor` on that app's RG, or a custom role | Subscription `Contributor`/`Owner` |
| Assign roles in an app RG (CI for identities) | `Role Based Access Control Administrator` **with conditions** restricting which roles can be assigned | `Owner`, `User Access Administrator` |
| App reads blobs in one container | `Storage Blob Data Reader` scoped to the container | Storage account keys, `Storage Account Contributor` |
| App reads secrets | `Key Vault Secrets User` on the vault (or one secret) | Access policies with all permissions, `Key Vault Administrator` |
| Pull images | `AcrPull` on the registry | ACR admin user |
| Network team | `Network Contributor` on network RGs | `Contributor` on subscription |

Conditional role assignment (delegate safely). This is done by the platform team or through IaC; the guard blocks agents from assigning this role directly:

```bash
az role assignment create --assignee-object-id <ci-mi-object-id> --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" --scope /subscriptions/S/resourceGroups/rg-orders-dev \
  --condition "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {2a2b9908-6ea1-4ae2-8e65-a410df84e7d1, 4633458b-17de-408a-b874-0445c86b69e6}))" \
  --condition-version "2.0"
```
(Allows assigning only Storage Blob Data Reader and Key Vault Secrets User; verify GUIDs with `az role definition list --name "<role>" --query [].name`.)

Custom roles: specific `Actions`/`DataActions`, assignable scopes limited to the subscription/RG, never `*` (guard-blocked).

## 3. Workload identities

- **Managed identity** for anything running in Azure. User-assigned (UAMI) when the identity must survive resource recreation or be shared by a fleet of identical instances; system-assigned otherwise.
- **Workload identity federation** (federated credentials on UAMI or app registration) for GitHub Actions, AKS pods, other clouds, Terraform Cloud. Subject must be exact (`repo:org/repo:environment:prod`, `system:serviceaccount:ns:sa`).
- App registrations: no client secrets; certificates only when federation is impossible, stored in Key Vault, short-lived, with rotation. Restrict API permissions to the minimum; **application** Graph permissions like `Directory.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All` are effectively tenant admin (guard-blocked).
- Set app management policies (tenant) to forbid password credentials.

## 4. Humans

- Groups, not individual assignments; group-based PIM for Azure resource roles (eligible, time-bound, approval + justification for prod).
- Conditional Access: MFA for all, phishing-resistant MFA for admins, block legacy auth, compliant/hybrid-joined devices for admin portals, sign-in risk policies (Entra ID P2).
- Break-glass accounts: 2, excluded from CA with monitoring alerts on sign-in, FIDO2, credentials in a safe.
- Access reviews quarterly for privileged roles and guest users.

## 5. Read-only audits

```bash
# Privileged assignments across a subscription (including inherited)
az role assignment list --all --include-inherited --subscription S \
  --query "[?roleDefinitionName=='Owner' || roleDefinitionName=='User Access Administrator' || roleDefinitionName=='Contributor'].{who:principalName,type:principalType,role:roleDefinitionName,scope:scope}" -o table
# Assignments to deleted principals (orphaned)
az role assignment list --all --query "[?principalName==''].{id:id,role:roleDefinitionName}" -o table
# Custom roles with wildcards
az role definition list --custom-role-only true --query "[].{n:roleName,actions:permissions[0].actions}" -o json
# Apps with password credentials (no values returned)
az ad app list --all --query "[?length(passwordCredentials)>\`0\`].{app:displayName,appId:appId}" -o table
# Managed identities and their federated credentials
az identity list --query "[].{n:name,rg:resourceGroup,principal:principalId}" -o table
az identity federated-credential list --identity-name ID -g RG --query "[].{n:name,issuer:issuer,subject:subject}" -o table
```

Entra sign-in and audit logs: via Log Analytics (if exported) or Microsoft Graph (`az rest --method GET --url "https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?\$top=20"` requires `AuditLog.Read.All`).

## 6. Troubleshooting `AuthorizationFailed` / 403

1. Error message names the action, scope and principal object id; confirm which identity (`az account show`, managed identity client id in the app).
2. `az role assignment list --assignee <objectId> --all --include-inherited -o table`.
3. Role contains the action? `az role definition list --name "<role>" --query "[].permissions[].{a:actions,da:dataActions,na:notActions}"`.
4. Data plane? Needs a data role (e.g. `Storage Blob Data Contributor`), and the resource must use RBAC data access (Key Vault RBAC mode, storage with Entra auth).
5. Propagation delay: new assignments can take up to ~10 minutes (longer for group membership tokens; sign out/in).
6. Deny assignments (`az role assignment list` won't show them: check `az rest` on `Microsoft.Authorization/denyAssignments`), Azure Policy `deny` effect (error says `RequestDisallowedByPolicy`), resource locks (`ScopeLocked`).
7. Propose the minimal role at the narrowest scope via IaC.

## Never

- Assign Owner / User Access Administrator / RBAC Administrator without conditions, or Entra directory roles (guard-blocked where detectable).
- Create client secrets (`credential reset`, `create-for-rbac`), or grant tenant-wide admin consent (guard-blocked).
- Use storage account keys / connection strings where Entra auth is possible.
- Delete users, groups, apps or service principals from an agent (guard-blocked).
