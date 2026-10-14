---
name: cloud-mcp-setup
description: Connect AI agents to AWS, Azure and Google Cloud through official MCP servers in read-only mode, with dedicated least-privilege identities, for Claude Code, Cursor, VS Code Copilot, Gemini CLI and Codex. Use when the user wants the agent to query live cloud resources, docs or pricing through MCP.
disable-model-invocation: true
---

# Cloud MCP Setup

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

MCP servers let you call cloud APIs directly instead of through shell commands. That also means **the cloud-guard shell hook does not see those calls**. Safety therefore comes from three things, all required:

1. **A dedicated read-only identity** for the MCP server (the real control).
2. **Server-side read-only mode** where the server supports it.
3. **Client-side approval** for every MCP tool call that can change something (never auto-approve mutating tools).

Write MCP config only after the user confirms. Never put credentials in MCP config files: point to a profile / login session / workload identity.

## 1. Create read-only identities (human runs these, or via IaC)

- **AWS**: an IAM Identity Center permission set (or role) with `ReadOnlyAccess` or, tighter, `ViewOnlyAccess` + `SecurityAudit`. Add an explicit deny for data reads you do not want the agent to see (`s3:GetObject`, `secretsmanager:GetSecretValue`, `ssm:GetParameter*`, `kms:Decrypt`, `dynamodb:GetItem/Query/Scan`, `logs:GetLogEvents` if logs contain PII). Profile e.g. `mcp-readonly-dev`.
- **Azure**: an Entra group with `Reader` (+ `Security Reader`) on the target subscriptions/resource groups. Note `Reader` does not grant data-plane access (blob contents, Key Vault secrets) by default; keep it that way. Sign in as that identity in the shell the MCP server uses, or use a separate Azure CLI config directory (`AZURE_CONFIG_DIR`).
- **GCP**: a service account or user with `roles/viewer` (+ `roles/iam.securityReviewer`), impersonated via `gcloud config set auth/impersonate_service_account mcp-ro@PROJECT.iam.gserviceaccount.com` in a dedicated gcloud configuration (`CLOUDSDK_ACTIVE_CONFIG_NAME=mcp-ro`). `roles/viewer` can read some data (for example BigQuery table metadata); prefer narrower predefined roles where possible.

Use nonprod scopes first. Production read access through MCP needs the owner's sign-off.

## 2. Server configs

### AWS API MCP server (awslabs)

```json
{
  "mcpServers": {
    "aws-api": {
      "command": "uvx",
      "args": ["awslabs.aws-api-mcp-server@latest"],
      "env": {
        "AWS_REGION": "us-east-1",
        "AWS_API_MCP_PROFILE_NAME": "mcp-readonly-dev",
        "READ_OPERATIONS_ONLY": "true",
        "REQUIRE_MUTATION_CONSENT": "true"
      }
    }
  }
}
```

Useful companions (no credentials needed): AWS Knowledge / documentation MCP servers and the pricing MCP server from `awslabs` for docs and cost lookups. Pin versions (`@x.y.z`) once you have tested one.

### Azure MCP server

```json
{
  "mcpServers": {
    "azure": {
      "command": "npx",
      "args": ["-y", "@azure/mcp@latest", "server", "start", "--read-only"],
      "env": { "AZURE_CONFIG_DIR": "/home/you/.azure-mcp-readonly" }
    }
  }
}
```

If your version does not support `--read-only`, remove the flag and rely on the `Reader`-only identity. The server uses the Azure CLI / developer credential chain; sign in with the read-only identity in that config dir.

### Google Cloud gcloud MCP server

```json
{
  "mcpServers": {
    "gcloud": {
      "command": "npx",
      "args": ["-y", "@google-cloud/gcloud-mcp", "-c", "/abs/path/gcloud-mcp-allow.json"],
      "env": { "CLOUDSDK_ACTIVE_CONFIG_NAME": "mcp-ro" }
    }
  }
}
```

`gcloud-mcp-allow.json` (allow-list read-only groups; a file can have `allow` or `deny`, not both):

```json
{ "allow": ["compute instances list", "compute instances describe", "container clusters list", "container clusters describe", "run services list", "run services describe", "projects get-iam-policy", "logging read", "asset search-all-resources"] }
```

Google also offers remote MCP endpoints for some services; access to those is controlled with IAM (see Google's "Control MCP use with IAM" docs). Same identity rules apply.

## 3. Where the config goes

| Client | Project file | Notes |
| --- | --- | --- |
| Claude Code | `.mcp.json` (`mcpServers`) | Keep `permissions.ask` for `mcp__aws-api__*` mutating tools; never add them to `allow` |
| Cursor | `.cursor/mcp.json` (`mcpServers`) | Disable auto-run for MCP tools |
| VS Code Copilot | `.vscode/mcp.json` (`servers`) | Tool approval prompts stay on |
| Gemini CLI | `.gemini/settings.json` (`mcpServers`) | Do not set `trust: true` on cloud servers |
| Codex | `~/.codex/config.toml` `[mcp_servers.aws-api]` | `command`, `args`, `env` keys |

## 4. Verify

After the user restarts the client so the server loads:

1. Call a read tool (list resources in a sandbox account/subscription/project). Expect success.
2. With the user's approval, attempt one harmless write in sandbox (add a tag). Expect a server refusal (read-only mode) or `AccessDenied`. If it succeeds, the identity is too broad: tell the user, stop using the server and help fix the identity.
3. Ask the user to confirm in cloud audit logs (CloudTrail / Activity Log / Audit Logs) that the calls show the MCP identity, not their admin identity.

## Never

- Point an MCP server at an admin/owner profile or a production break-glass identity.
- Store access keys, client secrets or SA key paths in MCP config.
- Auto-approve MCP tools from cloud servers, or enable "YOLO"/trust modes with them connected.
