// Hard guard rules for cloud-guard.
//
// Every rule is { id, level, re, reason, fix }.
//   level "deny": never executed by an agent, in any environment. A human may
//                 still run it themselves, outside the agent, after review.
//   level "ask" : always needs explicit human approval, even in sandbox.
//
// Rules match against a normalised command string: lower-cased, quotes
// removed, whitespace collapsed. Keep patterns anchored on the CLI name so
// they do not fire on prose (for example a commit message).
//
// Rule ids are stable. Policies refer to them in `overrides`.

const CLI = String.raw`(?:^|[\s;&|(\x60])`; // start of an invocation
const SP = String.raw`\s+(?:\S+\s+)*?`; // any tokens in between (lazy)
const OPEN = String.raw`(?:0\.0\.0\.0/0|::/0|\*|internet|any)`;
// SQL-content rules only fire when a database client is part of the command, so
// prose (commit messages, grep patterns) that merely mentions SQL is not blocked.
const DBCLI = String.raw`^(?=[\s\S]*\b(?:psql|mysql|mariadb|sqlcmd|invoke-sqlcmd|mongosh|mongo|sqlplus|cqlsh|sqlite3|duckdb|clickhouse-client|snowsql|dropdb|dropuser|mysqladmin|pg_dump|pg_dumpall|mysqldump|bq\s+query|gcloud\s+sql\s+connect)\b)[\s\S]*?`;

const r = (s) => new RegExp(s, "i");

export const HARD_RULES = [
  // ───────────────────────── Credential and secret exposure (all clouds) ─────────────────────────
  {
    id: "SECRET-CRED-FILE-READ",
    level: "deny",
    re: r(String.raw`(?:\.aws[\\/](?:credentials|config|sso[\\/]cache|cli[\\/]cache)|\.azure[\\/](?:msal_token_cache|accesstokens|service_principal_entries|azureprofile)|gcloud[\\/](?:credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials)|\.kube[\\/]config|\.docker[\\/]config\.json|\.terraform\.d[\\/]credentials|\.terraformrc|\.npmrc|\.netrc|\.ssh[\\/](?:id_[a-z0-9_]+|[^\s]*\.pem)|\.pgpass)`),
    reason: "Reads or transmits a local credential store. Credentials must never enter the agent transcript or leave the machine.",
    fix: "Use identity checks instead: `aws sts get-caller-identity`, `az account show`, `gcloud auth list`, `kubectl config current-context`.",
  },
  {
    id: "SECRET-ENV-DUMP",
    level: "deny",
    re: r(String.raw`(?:echo|printf|printenv|write-output|write-host)\s+[^|;&]*\$?(?:\{)?(?:env:)?(?:aws_secret_access_key|aws_session_token|arm_client_secret|azure_client_secret|google_credentials|google_application_credentials_json|github_token|gh_token|ci_job_token|vault_token|tf_token_[a-z0-9_]+|[a-z0-9_]*_(?:secret|password|token|api_key|apikey))(?![\w-])`),
    reason: "Prints a secret-bearing environment variable into the transcript.",
    fix: "Check presence without printing the value: `test -n \"$VAR\" && echo set`.",
  },
  {
    id: "SECRET-ENV-ALL",
    level: "ask",
    re: r(String.raw`(?:^|[;&|]\s*)(?:env|printenv|set|export\s+-p|get-childitem\s+env:|gci\s+env:|dir\s+env:)\s*(?:$|[|;&>])`),
    reason: "Dumps every environment variable, which commonly includes cloud credentials.",
    fix: "Print only the variable names you need, or check presence: `env | cut -d= -f1`.",
  },
  {
    id: "EXEC-ENCODED",
    level: "deny",
    re: r(String.raw`(?:base64\s+(?:-d|--decode)|frombase64string|certutil\s+-decode|xxd\s+-r)[^;]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|python[0-9.]*|node|perl)\b|-encodedcommand\b|\bpowershell(?:\.exe)?\s+-e(?:nc)?\s`),
    reason: "Executes an encoded or obfuscated payload. Guarded commands must be readable by the human approving them.",
    fix: "Run the plain command so it can be reviewed.",
  },
  {
    id: "EXEC-REMOTE-SCRIPT",
    level: "ask",
    re: r(String.raw`(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|pwsh|powershell|python[0-9.]*)(?![\w-])`),
    reason: "Pipes a remote script straight into a shell.",
    fix: "Download, inspect, pin a checksum, then run.",
  },
  {
    id: "SECRET-CLI-LITERAL",
    level: "deny",
    re: r(String.raw`(?:${CLI}az\s+login\b[^;|&]*\s(?:-p|--password)\s|${CLI}aws\s+configure\s+set\s+(?:aws_secret_access_key|aws_session_token)\b|--client-secret\s+[^\s$]|${CLI}docker\s+login\b[^;|&]*\s(?:-p|--password)\s)`),
    reason: "Puts a secret literal on the command line, where it lands in shell history, process lists and the transcript.",
    fix: "Use workload identity / OIDC, `az login --identity`, `aws sso login`, `gcloud auth login`, or `--password-stdin` from a secret manager.",
  },

  // ───────────────────────── AWS ─────────────────────────
  {
    id: "AWS-ORG-DESTRUCT",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}organizations\s+(?:delete-organization|leave-organization|remove-account-from-organization|close-account|delete-organizational-unit|detach-policy|delete-policy|disable-policy-type|disable-aws-service-access|deregister-delegated-administrator)(?![\w-])`),
    reason: "Changes AWS Organizations structure or removes SCP guardrails. This is a landing-zone change that must go through the organisation's change process.",
    fix: "Propose the change as IaC (Terraform / CloudFormation StackSets / Control Tower) in a pull request.",
  },
  {
    id: "AWS-ACCOUNT-CLOSE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}account\s+(?:close-account|delete-alternate-contact|disable-region)(?![\w-])`),
    reason: "Closes an account or alters account-level settings.",
    fix: "A human owner does this in the console with MFA.",
  },
  {
    id: "AWS-AUDIT-DISABLE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:cloudtrail\s+(?:stop-logging|delete-trail|delete-event-data-store|stop-event-data-store-ingestion)|guardduty\s+(?:delete-detector|disassociate-[\w-]+|delete-members|stop-monitoring-members|delete-publishing-destination|update-detector\b[^;|&]*--no-enable)|securityhub\s+(?:disable-security-hub|disable-import-findings-for-product|batch-disable-standards|disassociate-[\w-]+|delete-members)|configservice\s+(?:stop-configuration-recorder|delete-configuration-recorder|delete-delivery-channel|delete-config-rule|delete-conformance-pack|delete-configuration-aggregator)|accessanalyzer\s+delete-analyzer|macie2\s+(?:disable-macie|disable-organization-admin-account)|inspector2\s+disable\b|detective\s+delete-graph|ec2\s+delete-flow-logs|logs\s+(?:delete-subscription-filter|put-retention-policy\b[^;|&]*--retention-in-days\s+1\b)|fms\s+delete-policy|auditmanager\s+deregister-account)(?![\w-])`),
    reason: "Disables or deletes a security monitoring / audit control (CloudTrail, GuardDuty, Security Hub, Config, Access Analyzer, Macie, Inspector, flow logs).",
    fix: "Never switch off detective controls from an agent. If a control is noisy, tune it (suppression rules, finding filters) through IaC.",
  },
  {
    id: "AWS-KMS-DESTROY",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}kms\s+(?:schedule-key-deletion|disable-key|delete-imported-key-material|put-key-policy|disable-key-rotation|delete-custom-key-store|revoke-grant|retire-grant)(?![\w-])`),
    reason: "Deletes, disables or re-permissions a KMS key. Lost keys mean permanently unreadable data.",
    fix: "Change key policies through IaC with peer review; key deletion needs a documented data-retirement plan.",
  },
  {
    id: "AWS-S3-PUBLIC",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:s3api\s+(?:delete-public-access-block|put-public-access-block\b[^;|&]*(?:blockpublicacls|ignorepublicacls|blockpublicpolicy|restrictpublicbuckets)=false|put-bucket-acl\b[^;|&]*(?:public-read|public-read-write|authenticated-read|allusers|authenticatedusers)|put-object-acl\b[^;|&]*(?:public-read|public-read-write|allusers)|put-bucket-ownership-controls\b[^;|&]*objectwriter|put-bucket-policy\b[^;|&]*principal[^;|&]{0,6}\*)|s3control\s+(?:delete-public-access-block|put-public-access-block\b[^;|&]*=false)|s3\s+(?:cp|sync|mv)\b[^;|&]*--acl\s+public-read)`),
    reason: "Makes S3 data public or removes Block Public Access.",
    fix: "Serve public content through CloudFront with Origin Access Control; keep Block Public Access on at account and bucket level.",
  },
  {
    id: "AWS-S3-BULK-DELETE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:s3\s+rb\b[^;|&]*--force|s3api\s+delete-bucket\b|s3api\s+(?:delete-bucket-policy|delete-bucket-encryption|delete-bucket-lifecycle|put-bucket-versioning\b[^;|&]*suspended|put-object-lock-configuration|delete-bucket-replication))`),
    reason: "Deletes a bucket or strips its protection (versioning, encryption, policy, replication, object lock).",
    fix: "Bucket removal and protection changes go through IaC with a reviewed plan.",
  },
  {
    id: "AWS-S3-RECURSIVE-RM",
    level: "ask",
    re: r(String.raw`${CLI}aws${SP}s3\s+(?:rm\b[^;|&]*--recursive|sync\b[^;|&]*--delete)`),
    reason: "Recursively deletes S3 objects.",
    fix: "Run with --dryrun first and confirm the exact prefix.",
  },
  {
    id: "AWS-IAM-ESCALATE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}iam\s+(?:create-access-key|attach-(?:user|role|group)-policy\b[^;|&]*(?:administratoraccess|iamfullaccess|poweruseraccess)|put-(?:user|role|group)-policy\b[^;|&]*action[^;|&]{0,8}\*[^;|&]*resource[^;|&]{0,8}\*|update-assume-role-policy\b[^;|&]*principal[^;|&]{0,10}(?:\*|aws[^;|&]{0,6}\*)|delete-account-password-policy|deactivate-mfa-device|delete-virtual-mfa-device|create-login-profile|update-login-profile|delete-role-permissions-boundary|delete-user-permissions-boundary|add-user-to-group\b[^;|&]*admin|set-default-policy-version|upload-ssh-public-key|upload-signing-certificate|create-service-specific-credential)(?![\w-])`),
    reason: "Creates long-lived credentials, grants admin, opens a trust policy to any principal, or removes an identity guardrail.",
    fix: "Use IAM Identity Center / roles with least-privilege policies defined in IaC; CI uses OIDC federation, not access keys.",
  },
  {
    id: "AWS-NET-OPEN-ADMIN",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}ec2\s+authorize-security-group-ingress\b(?=[^;|&]*(?:0\.0\.0\.0/0|::/0))(?=[^;|&]*(?:--port\s+(?:22|3389|-1|0-65535|5432|3306|1433|6379|27017|9200|2379)\b|fromport=(?:22|3389|-1|5432|3306|1433|6379|27017)\b|ipprotocol=-1|--protocol\s+(?:-1|all)\b))`),
    reason: "Opens SSH/RDP/database/all ports to the internet.",
    fix: "Use SSM Session Manager (no inbound ports), a VPN, or a source CIDR you own.",
  },
  {
    id: "AWS-NET-OPEN-ANY",
    level: "ask",
    re: r(String.raw`${CLI}aws${SP}ec2\s+authorize-security-group-ingress\b[^;|&]*(?:0\.0\.0\.0/0|::/0)`),
    reason: "Opens a port to the whole internet.",
    fix: "Confirm this is a deliberate public endpoint (80/443 behind a load balancer) and prefer WAF + ALB.",
  },
  {
    id: "AWS-PUBLIC-SHARE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:ec2\s+(?:modify-image-attribute|modify-snapshot-attribute)\b[^;|&]*(?:group=all|--group-names\s+all|"all")|ec2\s+(?:disable-image-block-public-access|disable-snapshot-block-public-access|disable-ebs-encryption-by-default)|rds\s+modify-db(?:-cluster)?-snapshot-attribute\b[^;|&]*--values-to-add[^;|&]*\ball\b|lambda\s+add-permission\b[^;|&]*--principal\s+\*|ecr\s+set-repository-policy\b[^;|&]*principal[^;|&]{0,6}\*|sns\s+(?:add-permission|set-topic-attributes)\b[^;|&]*principal[^;|&]{0,6}\*|sqs\s+(?:add-permission|set-queue-attributes)\b[^;|&]*principal[^;|&]{0,6}\*|glacier\s+set-vault-access-policy|backup\s+put-backup-vault-access-policy\b[^;|&]*principal[^;|&]{0,6}\*)`),
    reason: "Shares an image, snapshot, function, repository, topic or queue publicly, or disables an account-level public-sharing/encryption block.",
    fix: "Share with specific account IDs or the organisation (aws:PrincipalOrgID) only.",
  },
  {
    id: "AWS-DB-UNSAFE",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:rds\s+(?:modify-db-instance|modify-db-cluster|create-db-instance|restore-db-instance-[\w-]+)\b[^;|&]*--publicly-accessible\b|rds\s+delete-db-(?:instance|cluster)\b[^;|&]*--skip-final-snapshot|rds\s+(?:modify-db-instance|modify-db-cluster)\b[^;|&]*--no-deletion-protection|rds\s+delete-db-(?:cluster-)?snapshot|dynamodb\s+update-table\b[^;|&]*--no-deletion-protection-enabled|dynamodb\s+update-continuous-backups\b[^;|&]*pointintimerecoveryenabled=false|redshift\s+(?:modify-cluster\b[^;|&]*--publicly-accessible|delete-cluster\b[^;|&]*--skip-final-cluster-snapshot)|docdb\s+delete-db-cluster\b[^;|&]*--skip-final-snapshot|elasticache\s+delete-[\w-]+\b[^;|&]*--no-final-snapshot)`),
    reason: "Makes a database public, removes its deletion protection / backups, or deletes it without a final snapshot.",
    fix: "Keep databases private, deletion-protected and backed up; deletions take a final snapshot and go through IaC.",
  },
  {
    id: "AWS-BACKUP-DESTROY",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:backup\s+(?:delete-backup-vault|delete-recovery-point|delete-backup-plan|delete-backup-vault-lock-configuration|disassociate-recovery-point)|ec2\s+(?:delete-snapshot|deregister-image)\b[^;|&]*--(?:snapshot-id|image-id)\s+\S+\s+\S)`),
    reason: "Destroys backups or recovery points.",
    fix: "Retention is managed by backup plans/lifecycle in IaC.",
  },
  {
    id: "AWS-PROTECTION-OFF",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:cloudformation\s+update-termination-protection\b[^;|&]*--no-enable|ec2\s+modify-instance-attribute\b[^;|&]*--no-disable-api-termination|elbv2\s+modify-load-balancer-attributes\b[^;|&]*deletion_protection\.enabled,value=false|route53\s+delete-hosted-zone|route53domains\s+(?:transfer-domain|disable-domain-transfer-lock|delete-domain)|wafv2\s+(?:delete-web-acl|disassociate-web-acl)|shield\s+delete-[\w-]+|cloudfront\s+delete-distribution|acm\s+delete-certificate|ssm\s+(?:delete-document|stop-automation-execution)\b|organizations\s+update-policy|sso-admin\s+delete-[\w-]+|identitystore\s+delete-[\w-]+)`),
    reason: "Removes deletion/termination protection, edge protection, DNS zones, domains, or identity-centre configuration.",
    fix: "Make these changes in IaC with peer review and a rollback plan.",
  },
  {
    id: "AWS-SECRET-READ",
    level: "deny",
    re: r(String.raw`${CLI}aws${SP}(?:secretsmanager\s+(?:get-secret-value|batch-get-secret-value)|ssm\s+get-parameters?(?:-by-path)?\b[^;|&]*--with-decryption|configure\s+(?:get\s+(?:aws_secret_access_key|aws_session_token)|export-credentials)|iam\s+(?:get-credential-report|generate-credential-report)\b[^;|&]*--output\s+text|ec2\s+get-password-data\b[^;|&]*--priv-launch-key|lightsail\s+get-instance-access-details|kms\s+decrypt\b|sts\s+get-session-token|cognito-idp\s+admin-initiate-auth)`),
    reason: "Materialises a secret, decrypted parameter, password or session credential into the transcript.",
    fix: "Reference secrets by ARN from the workload (IAM role + SDK at runtime). To verify a secret exists: `aws secretsmanager describe-secret`.",
  },
  {
    id: "AWS-TOKEN-PRINT",
    level: "ask",
    re: r(String.raw`${CLI}aws${SP}(?:ecr\s+get-login-password|ecr-public\s+get-login-password|codeartifact\s+get-authorization-token|sts\s+assume-role(?:-with-web-identity|-with-saml)?|eks\s+get-token|rds\s+generate-db-auth-token|s3\s+presign)(?![\w-])`),
    reason: "Prints a short-lived token or presigned URL.",
    fix: "Only pipe it directly into its consumer (for example `| docker login --password-stdin`), never echo it.",
  },

  // ───────────────────────── Azure ─────────────────────────
  {
    id: "AZ-TENANT-DESTRUCT",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}(?:account\s+management-group\s+(?:delete|subscription\s+remove)|account\s+subscription\s+cancel|account\s+alias\s+delete|ad\s+(?:user|group|app|sp)\s+delete|ad\s+app\s+permission\s+(?:admin-consent|grant))(?![\w-])`),
    reason: "Deletes tenant-level identity objects, management groups, subscriptions, or grants tenant-wide admin consent.",
    fix: "Tenant and landing-zone changes go through the platform team's IaC and approval flow.",
  },
  {
    id: "AZ-GOVERNANCE-OFF",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}(?:lock\s+delete|resource\s+lock\s+delete|group\s+lock\s+delete|account\s+lock\s+delete|policy\s+(?:assignment\s+delete|exemption\s+create|definition\s+delete|set-definition\s+delete)|security\s+(?:pricing\s+create\b[^;|&]*--tier\s+free|auto-provisioning-setting\s+update\b[^;|&]*--auto-provision\s+off|setting\s+update\b[^;|&]*--enabled\s+false|contact\s+delete|workspace-setting\s+delete)|monitor\s+(?:diagnostic-settings\s+delete|log-profiles\s+delete|activity-log\s+alert\s+delete)|monitor\s+log-analytics\s+workspace\s+(?:delete|update\b[^;|&]*--retention-time\s+[0-9]\b)|sentinel\s+[\w-]+\s+delete|network\s+watcher\s+flow-log\s+delete|backup\s+protection\s+disable|backup\s+vault\s+(?:delete|backup-properties\s+set\b[^;|&]*--soft-delete-feature-state\s+disable))(?![\w-])`),
    reason: "Removes a resource lock, policy assignment, Defender plan, diagnostic setting, flow log or backup protection, or creates a policy exemption.",
    fix: "Guardrail changes go through the policy-as-code repo with security sign-off.",
  },
  {
    id: "AZ-RBAC-ESCALATE",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}(?:role\s+assignment\s+create\b[^;|&]*--role\s+(?:owner|user\s+access\s+administrator|role\s+based\s+access\s+control\s+administrator|8e3af657-a8ff-443c-a75c-2fe8c4bcb635|18d7d88d-d35e-4fb5-a5c3-7773c20a72d9)|role\s+definition\s+(?:create|update)\b[^;|&]*actions[^;|&]{0,8}\*|ad\s+(?:sp|app)\s+(?:credential\s+reset|create-for-rbac)|ad\s+app\s+(?:update|permission\s+add)\b[^;|&]*(?:roleassignment\.readwrite|directory\.readwrite|approleassignment\.readwrite|application\.readwrite\.all)|rest\b[^;|&]*elevateaccess)`),
    reason: "Grants Owner / User Access Administrator, creates wildcard roles, mints client secrets, grants high-privilege Graph permissions or elevates to tenant root.",
    fix: "Use managed identities or workload identity federation, scoped built-in roles, and PIM for elevated access.",
  },
  {
    id: "AZ-SECRET-READ",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}(?:keyvault\s+(?:secret\s+(?:show|download|backup)|key\s+(?:download|backup|decrypt|unwrap-key)|certificate\s+(?:download|backup)|secret\s+list-versions\b[^;|&]*--query[^;|&]*value)|storage\s+account\s+(?:keys\s+(?:list|renew)|show-connection-string)|cosmosdb\s+keys\s+list|cosmosdb\s+list-(?:keys|connection-strings|read-only-keys)|redis\s+list-keys|acr\s+credential\s+(?:show|renew)|(?:servicebus|eventhubs|relay|notification-hub)\b[^;|&]*authorization-rule\s+keys\s+list|webapp\s+deployment\s+list-publishing-(?:profiles|credentials)|functionapp\s+(?:keys\s+list|function\s+keys\s+list|deployment\s+list-publishing-(?:profiles|credentials))|cognitiveservices\s+account\s+keys\s+list|search\s+admin-key\s+show|signalr\s+key\s+list|webpubsub\s+key\s+show|maps\s+account\s+keys\s+list|batch\s+account\s+keys\s+list|iot\s+hub\s+connection-string\s+show|aks\s+get-credentials\b[^;|&]*--file\s+-|account\s+get-access-token|appconfig\s+credential\s+list|sql\s+server\s+ad-admin)(?![\w-])`),
    reason: "Prints secrets, keys, connection strings, publishing credentials or access tokens into the transcript.",
    fix: "Use Key Vault references and managed identity at runtime. To verify a secret exists: `az keyvault secret list --vault-name X --query [].name`.",
  },
  {
    id: "AZ-PUBLIC-DATA",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}(?:storage\s+container\s+(?:set-permission|create)\b[^;|&]*--public-access\s+(?:blob|container)|storage\s+account\s+(?:update|create)\b[^;|&]*(?:--allow-blob-public-access\s+true|--allow-shared-key-access\s+true|--min-tls-version\s+tls1_[01]|--https-only\s+false|--public-network-access\s+enabled\b[^;|&]*--default-action\s+allow)|acr\s+update\b[^;|&]*--admin-enabled\s+true|acr\s+update\b[^;|&]*--anonymous-pull-enabled\s+true|keyvault\s+(?:update|create)\b[^;|&]*(?:--default-action\s+allow|--enable-rbac-authorization\s+false)|keyvault\s+(?:purge|delete|key\s+(?:delete|purge)|secret\s+purge|certificate\s+purge)|sql\s+server\s+firewall-rule\s+create\b[^;|&]*--end-ip-address\s+255\.255\.255\.255|(?:postgres|mysql)\s+flexible-server\s+firewall-rule\s+create\b[^;|&]*--end-ip-address\s+255\.255\.255\.255|cosmosdb\s+update\b[^;|&]*--ip-range-filter\s+0\.0\.0\.0(?:\s|$)|sql\s+server\s+update\b[^;|&]*--enable-public-network\s+true|webapp\s+config\s+set\b[^;|&]*--ftps-state\s+allallowed)`),
    reason: "Exposes data publicly, enables shared-key / admin / anonymous access, weakens TLS, or deletes/purges Key Vault content.",
    fix: "Use private endpoints, Entra ID auth (managed identity), TLS 1.2+, and keep soft-delete + purge protection.",
  },
  {
    id: "AZ-NET-OPEN-ADMIN",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}network\s+nsg\s+rule\s+(?:create|update)\b(?=[^;|&]*--access\s+allow)(?=[^;|&]*--source-address-prefixes?\s+(?:\*|internet|any|0\.0\.0\.0/0))(?=[^;|&]*--destination-port-ranges?\s+(?:\*|22|3389|1433|3306|5432|6379|5985|5986|0-65535)\b)`),
    reason: "Opens SSH/RDP/WinRM/database/all ports to the internet in an NSG.",
    fix: "Use Azure Bastion or Just-In-Time VM access; restrict to known source ranges.",
  },
  {
    id: "AZ-DEPLOY-COMPLETE",
    level: "deny",
    re: r(String.raw`${CLI}az${SP}deployment\s+(?:group|sub|mg|tenant)\s+create\b[^;|&]*--mode\s+complete`),
    reason: "Complete-mode deployment deletes every resource in scope that is not in the template.",
    fix: "Use Incremental mode or Deployment Stacks with explicit deny settings, and run `what-if` first.",
  },
  {
    id: "AZ-DESTROY-SCOPE",
    level: "ask",
    re: r(String.raw`${CLI}az${SP}(?:group\s+delete|resource\s+delete\b[^;|&]*--ids|stack\s+(?:group|sub|mg)\s+delete\b[^;|&]*--action-on-unmanage\s+deleteall|aks\s+delete|sql\s+(?:server|db)\s+delete|cosmosdb\s+(?:delete|sql\s+database\s+delete)|storage\s+account\s+delete|vm\s+delete|vmss\s+delete)(?![\w-])`),
    reason: "Deletes a resource group, cluster, database, storage account or VM.",
    fix: "Confirm the exact scope; prefer IaC removal with a reviewed plan.",
  },

  // ───────────────────────── Google Cloud ─────────────────────────
  {
    id: "GCP-HIERARCHY-DESTRUCT",
    level: "deny",
    re: r(String.raw`${CLI}gcloud${SP}(?:projects\s+(?:delete|move)|resource-manager\s+folders\s+(?:delete|move)|organizations\s+(?:set-iam-policy|remove-iam-policy-binding)|beta\s+billing\s+projects\s+unlink|billing\s+projects\s+unlink|resource-manager\s+liens\s+delete)(?![\w-])`),
    reason: "Deletes or moves a project/folder, unlinks billing (which stops all services) or removes a lien.",
    fix: "Resource hierarchy changes go through the landing-zone IaC with owner approval.",
  },
  {
    id: "GCP-ORG-POLICY-OFF",
    level: "deny",
    re: r(String.raw`${CLI}gcloud${SP}(?:resource-manager\s+org-policies\s+(?:disable-enforce|delete|allow)|org-policies\s+(?:delete|reset)|access-context-manager\s+perimeters\s+(?:delete|dry-run\s+enforce)|scc\s+(?:notifications\s+delete|muteconfigs\s+create|settings\s+services\s+disable)|logging\s+(?:sinks\s+delete|buckets\s+(?:delete|update\b[^;|&]*--retention-days\s+[0-9]\b)|settings\s+update\b[^;|&]*--disable-default-sink)|services\s+disable\s+(?:[^;|&]*\s)?(?:securitycenter|logging|cloudkms|cloudasset|accesscontextmanager|containeranalysis|binaryauthorization)\.googleapis\.com|compute\s+(?:networks\s+subnets\s+update\b[^;|&]*--no-enable-flow-logs|security-policies\s+delete)|kms\s+keys\s+versions\s+(?:destroy|disable)|kms\s+keys\s+(?:remove-rotation-schedule|set-iam-policy)|projects\s+(?:remove-iam-policy-binding\b[^;|&]*roles/logging|set-iam-policy)|iam\s+service-accounts\s+(?:delete|disable)\b[^;|&]*(?:terraform|deploy|ci|cd)|access-approval\s+settings\s+delete|beta\s+audit-manager|logging\s+settings\s+update\b[^;|&]*--disable)(?![\w-])`),
    reason: "Disables an org policy, VPC Service Controls perimeter, audit logging, Security Command Center, flow logs, Cloud Armor, KMS key or replaces a whole IAM policy.",
    fix: "Change guardrails in the org-policy / landing-zone IaC with security approval; use `add-iam-policy-binding` (additive) through IaC rather than `set-iam-policy`.",
  },
  {
    id: "GCP-IAM-ESCALATE",
    level: "deny",
    re: r(String.raw`${CLI}gcloud${SP}(?:(?:projects|resource-manager\s+folders|organizations|iam\s+service-accounts|storage\s+buckets|functions|run\s+services|pubsub\s+topics|secrets|kms\s+keys|artifacts\s+repositories|bigquery)\s+add-iam-policy-binding\b[^;|&]*(?:--member[= ](?:allusers|allauthenticatedusers)|--role[= ]roles/(?:owner|editor|iam\.securityadmin|iam\.serviceaccountadmin|iam\.serviceaccounttokencreator|iam\.serviceaccountkeyadmin|iam\.workloadidentitypooladmin|resourcemanager\.organizationadmin|resourcemanager\.projectiamadmin|resourcemanager\.folderadmin|billing\.admin|iam\.organizationroleadmin|orgpolicy\.policyadmin))|iam\s+service-accounts\s+keys\s+(?:create|upload)|iam\s+roles\s+(?:create|update)\b[^;|&]*--permissions[^;|&]*(?:\.setiampolicy|iam\.serviceaccounts\.(?:getaccesstoken|actas|implicitdelegation|signjwt|signblob)|iam\.serviceaccountkeys\.create)|iam\s+workload-identity-pools\s+providers\s+(?:create|update)[\w-]*\b(?![^;|&]*--attribute-condition))`),
    reason: "Grants public, basic (owner/editor) or privilege-escalating roles, creates a service account key, or creates a workload identity provider with no attribute condition.",
    fix: "Grant narrow predefined roles to groups or dedicated service accounts via IaC; CI uses Workload Identity Federation with an attribute condition.",
  },
  {
    id: "GCP-PUBLIC-DATA",
    level: "deny",
    re: r(String.raw`(?:${CLI}gcloud${SP}(?:storage\s+buckets\s+(?:update|create)\b[^;|&]*(?:--no-public-access-prevention|--public-access-prevention[= ]inherited|--no-uniform-bucket-level-access)|storage\s+(?:objects\s+update|cp)\b[^;|&]*(?:--predefined-acl[= ]publicread|--add-acl-grant[^;|&]*allusers)|sql\s+instances\s+(?:patch|create)\b[^;|&]*(?:--authorized-networks[= ][^;|&]*0\.0\.0\.0/0|--no-require-ssl|--ssl-mode[= ]allow_unencrypted_and_encrypted|--assign-ip\b[^;|&]*--authorized-networks)|compute\s+images\s+add-iam-policy-binding\b[^;|&]*allauthenticatedusers|container\s+clusters\s+(?:update|create)\b[^;|&]*(?:--enable-legacy-authorization|--no-enable-master-authorized-networks|--master-authorized-networks[= ]0\.0\.0\.0/0|--no-enable-shielded-nodes|--enable-basic-auth|--issue-client-certificate)|functions\s+deploy\b[^;|&]*--allow-unauthenticated|run\s+(?:deploy|services\s+update)\b[^;|&]*--allow-unauthenticated)|${CLI}gsutil${SP}(?:iam\s+ch\s+(?:-d\s+)?allusers|iam\s+ch\b[^;|&]*all(?:authenticated)?users|acl\s+(?:ch|set)\b[^;|&]*(?:allusers|allauthenticatedusers|public-read)|defacl\s+(?:ch|set)\b[^;|&]*(?:allusers|public-read)|pap\s+set\s+inherited|ubla\s+set\s+off))`),
    reason: "Makes storage, images, databases or clusters publicly reachable, weakens TLS, or enables legacy auth.",
    fix: "Keep public access prevention + uniform bucket-level access; use Cloud SQL Auth Proxy / private IP, IAP or an authenticated load balancer. Public services need an explicit, reviewed IaC change.",
  },
  {
    id: "GCP-NET-OPEN-ADMIN",
    level: "deny",
    re: r(String.raw`${CLI}gcloud${SP}compute\s+firewall-rules\s+(?:create|update)\b(?=[^;|&]*--source-ranges[= ](?:[^;|&\s]*,)?0\.0\.0\.0/0)(?=[^;|&]*(?:--allow[= ](?:[^;|&\s]*,)?(?:tcp:(?:22|3389|5432|3306|1433|6379|27017)\b|tcp\b(?!:)|all|udp\b(?!:))|--rules[= ](?:[^;|&\s]*,)?(?:tcp:(?:22|3389|5432|3306)\b|all)))`),
    reason: "Opens SSH/RDP/database/all ports to the internet.",
    fix: "Use IAP TCP forwarding (source 35.235.240.0/20) or OS Login over IAP.",
  },
  {
    id: "GCP-SECRET-READ",
    level: "deny",
    re: r(String.raw`(?:${CLI}gcloud${SP}(?:secrets\s+versions\s+access|auth\s+(?:print-access-token|print-identity-token|application-default\s+print-access-token)|kms\s+decrypt|iam\s+service-accounts\s+(?:sign-blob|sign-jwt)|sql\s+(?:users\s+set-password\b[^;|&]*--password[= ]\S|generate-login-token)|container\s+clusters\s+describe\b[^;|&]*masterauth)|${CLI}bq\s+(?:query|head)\b[^;|&]*\b(?:password|secret|token|ssn|credit_card)\b)`),
    reason: "Prints a secret, access/identity token or decrypted value into the transcript.",
    fix: "Workloads read Secret Manager at runtime with their own identity. To verify a secret exists: `gcloud secrets describe NAME`.",
  },
  {
    id: "GCP-DESTROY-DATA",
    level: "ask",
    re: r(String.raw`(?:${CLI}gcloud${SP}(?:storage\s+rm\b[^;|&]*(?:--recursive|-r\b)|storage\s+buckets\s+delete|sql\s+instances\s+delete|spanner\s+(?:instances|databases)\s+delete|bigtable\s+instances\s+delete|firestore\s+databases\s+delete|container\s+clusters\s+delete|compute\s+(?:instances|disks|snapshots|images)\s+delete|filestore\s+instances\s+delete|redis\s+instances\s+delete|alloydb\s+clusters\s+delete)|${CLI}gsutil${SP}(?:-m\s+)?(?:rm\b[^;|&]*-r|rb)\b|${CLI}bq\s+rm\b)`),
    reason: "Deletes data stores, clusters, disks or buckets.",
    fix: "Confirm exact scope; deletion protection and IaC removal are preferred.",
  },

  // ───────────────────────── IaC tools ─────────────────────────
  {
    id: "IAC-UNREVIEWED-APPLY",
    level: "deny",
    re: r(String.raw`(?:${CLI}(?:terraform|tofu|terragrunt)${SP}(?:apply|destroy)\b[^;|&]*(?:-auto-approve|--auto-approve)|${CLI}terragrunt${SP}(?:run-all|run\s+--all)\s+(?:apply|destroy)|${CLI}terragrunt\b[^;|&]*--terragrunt-non-interactive[^;|&]*(?:apply|destroy)|${CLI}pulumi${SP}(?:up|destroy|refresh)\b[^;|&]*(?:--yes|-y\b|--skip-preview)|${CLI}cdk${SP}(?:deploy\b[^;|&]*--require-approval[= ]never|destroy\b[^;|&]*(?:--force|-f\b))|${CLI}cdktf${SP}(?:deploy|destroy)\b[^;|&]*--auto-approve|${CLI}sam${SP}deploy\b[^;|&]*--no-confirm-changeset|${CLI}eksctl${SP}delete\s+cluster|${CLI}serverless${SP}remove|${CLI}(?:sls)${SP}remove)`),
    reason: "Applies or destroys infrastructure without a human reviewing the plan.",
    fix: "Run `plan`/`preview`/`diff`/`what-if`, show it to the human, and let them (or the CI pipeline) apply.",
  },
  {
    id: "IAC-DESTROY",
    level: "deny",
    re: r(String.raw`(?:${CLI}(?:terraform|tofu|terragrunt)${SP}(?:destroy\b|apply\b[^;|&]*-destroy\b|plan\b[^;|&]*-destroy\b[^;|&]*-out)|${CLI}pulumi${SP}(?:destroy|stack\s+rm)\b|${CLI}cdk${SP}destroy\b)`),
    reason: "Destroys a whole stack / workspace.",
    fix: "Whole-stack destruction is a human decision executed by a human or a gated pipeline.",
  },
  {
    id: "IAC-STATE-SURGERY",
    level: "ask",
    re: r(String.raw`${CLI}(?:terraform|tofu|terragrunt)${SP}(?:state\s+(?:rm|mv|replace-provider)|force-unlock|import|taint|untaint|workspace\s+delete)(?![\w-])`),
    reason: "Edits Terraform state directly. Mistakes orphan or duplicate real infrastructure.",
    fix: "Back up state first (`terraform state pull > backup.tfstate` in a gitignored path), prefer `moved`/`import`/`removed` blocks in code.",
  },
  {
    id: "IAC-STATE-OVERWRITE",
    level: "deny",
    re: r(String.raw`${CLI}(?:terraform|tofu|terragrunt)${SP}state\s+push\b`),
    reason: "Overwrites remote state.",
    fix: "Use `moved`, `import` or `removed` blocks so changes are reviewable.",
  },
  {
    id: "IAC-SECRET-OUTPUT",
    level: "ask",
    re: r(String.raw`(?:${CLI}(?:terraform|tofu|terragrunt)${SP}(?:output\b[^;|&]*(?:-json|-raw)|show\b[^;|&]*-json|state\s+pull|console)|${CLI}pulumi${SP}(?:config\s+get|stack\s+output|stack\s+export|config)\b[^;|&]*--show-secrets)`),
    reason: "Can print sensitive values from state/outputs in clear text.",
    fix: "Use `terraform output` without -json/-raw (sensitive values stay masked) or filter to the non-sensitive key you need.",
  },

  // ───────────────────────── Kubernetes ─────────────────────────
  {
    id: "K8S-SECRET-READ",
    level: "deny",
    re: r(String.raw`(?:${CLI}(?:kubectl|oc|k)${SP}(?:get\s+(?:secrets?|secret/\S+)\b[^;|&]*(?:-o|--output)[= ]?(?:yaml|json|jsonpath|go-template|custom-columns|wide)|describe\s+secrets?\b[^;|&]*--show-|config\s+view\b[^;|&]*--raw|create\s+token\b|view-secret\b)|${CLI}helm${SP}get\s+(?:values|all|manifest)\b[^;|&]*(?:-a|--all))`),
    reason: "Prints Kubernetes secret data, raw kubeconfig credentials or service-account tokens.",
    fix: "List secret names only (`kubectl get secrets` without -o). To see which keys a workload uses, describe the Deployment / pod spec instead of the Secret.",
  },
  {
    id: "K8S-ESCALATE",
    level: "deny",
    re: r(String.raw`${CLI}(?:kubectl|oc|k)${SP}(?:create\s+(?:clusterrolebinding|rolebinding)\b[^;|&]*(?:cluster-admin|--clusterrole[= ]admin|system:masters)|(?:label|annotate)\s+(?:ns|namespace)\b[^;|&]*pod-security\.kubernetes\.io/enforce=privileged|run\b[^;|&]*--privileged|debug\s+node/|delete\s+(?:validatingwebhookconfiguration|mutatingwebhookconfiguration|clusterpolicy|constrainttemplate|networkpolic(?:y|ies))\b|patch\b[^;|&]*(?:"privileged"\s*:\s*true|hostpid|hostnetwork|hostpath))`),
    reason: "Grants cluster-admin, enables privileged workloads / host access, or removes an admission or network guardrail.",
    fix: "Bind narrow Roles to groups via GitOps; privileged workloads need a documented security exception.",
  },
  {
    id: "K8S-MASS-DELETE",
    level: "deny",
    re: r(String.raw`${CLI}(?:kubectl|oc|k)${SP}delete\b[^;|&]*(?:\s--all\b|\s-A\b|--all-namespaces|\s(?:ns|namespace|namespaces)\s+(?:kube-system|kube-public|default|istio-system|gatekeeper-system|kyverno|cert-manager|argocd|flux-system|monitoring)\b|\s(?:crd|crds|customresourcedefinitions?|nodes?|pv|persistentvolumes?|storageclass)\b)`),
    reason: "Mass-deletes resources, system namespaces, CRDs (which cascade-delete every custom resource), nodes or volumes.",
    fix: "Delete specific named resources after confirming context and namespace; CRD removal goes through GitOps.",
  },
  {
    id: "K8S-NS-DELETE",
    level: "ask",
    re: r(String.raw`${CLI}(?:kubectl|oc|k)${SP}(?:delete\s+(?:ns|namespace)\b|drain\b|exec\b|cp\b|port-forward\b|proxy\b|replace\b[^;|&]*--force|delete\b[^;|&]*--force|delete\b[^;|&]*--grace-period[= ]0)`),
    reason: "Deletes a namespace, drains a node, force-deletes, or opens an interactive / tunnelled session into a workload.",
    fix: "Confirm cluster context, namespace and blast radius first.",
  },
  {
    id: "HELM-UNINSTALL",
    level: "ask",
    re: r(String.raw`${CLI}helm${SP}(?:uninstall|delete|rollback)(?![\w-])`),
    reason: "Removes or rolls back a Helm release.",
    fix: "Check `helm history` and confirm the target revision.",
  },

  // ───────────────────────── Git and GitHub ─────────────────────────
  {
    id: "GIT-FORCE-PROTECTED",
    level: "deny",
    re: r(String.raw`${CLI}git${SP}push\b(?=[^;|&]*(?:\s-f\b|\s--force\b|--force-with-lease|--force-if-includes|\s\+[\w./-]))(?=[^;|&]*(?:\s|:|\+|/)(?:main|master|trunk|develop|release[\w./-]*|prod|production|hotfix[\w./-]*)(?:\s|$))`),
    reason: "Force-pushes to a protected branch (main/master/develop/release/prod), rewriting shared history.",
    fix: "Push a new branch and open a pull request. If history really must be rewritten, a maintainer does it with branch protection temporarily adjusted.",
  },
  {
    id: "GIT-DELETE-PROTECTED",
    level: "deny",
    re: r(String.raw`${CLI}git${SP}push\b(?=[^;|&]*(?:--delete|\s-d)\b)[^;|&]*\s(?:main|master|trunk|develop|release[\w./-]*|prod|production)(?:\s|$)|${CLI}git${SP}push\s+\S+\s+:(?:main|master|trunk|develop|release[\w./-]*|prod|production)(?:\s|$)`),
    reason: "Deletes a protected branch on the remote.",
    fix: "Branch deletion of long-lived branches is a maintainer decision.",
  },
  {
    id: "GIT-FORCE-PUSH",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}push\b[^;|&]*(?:\s-f\b|\s--force(?![-\w])|\s\+[\w./-])`),
    reason: "Force-pushes and can overwrite other people's commits.",
    fix: "Use --force-with-lease on your own feature branch only.",
  },
  {
    id: "GIT-HISTORY-DESTROY",
    level: "deny",
    re: r(String.raw`${CLI}git${SP}(?:reflog\s+(?:expire|delete)|gc\b[^;|&]*--prune=(?:now|all)|update-ref\s+-d|prune\b[^;|&]*--expire[= ]?now)`),
    reason: "Destroys the local recovery history (reflog / unreachable objects) that is used to undo mistakes.",
    fix: "Leave reflog and gc defaults alone; repositories clean themselves up safely.",
  },
  {
    id: "GIT-HISTORY-REWRITE",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}(?:filter-branch|filter-repo|replace\b|rebase\b[^;|&]*(?:--root|-i\b|--interactive)|commit\b[^;|&]*--amend\b[^;|&]*--no-edit)|${CLI}bfg\b`),
    reason: "Rewrites commit history.",
    fix: "Only on unpushed or personal branches; for secret removal follow the git-secrets-history skill with a maintainer.",
  },
  {
    id: "GIT-DISCARD-WORK",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}(?:reset\b[^;|&]*--hard|clean\b[^;|&]*-[a-z]*f|checkout\s+(?:--\s+)?\.(?:\s|$)|checkout\b[^;|&]*\s--\s+\S|restore\s+(?:--worktree\s+)?\.(?:\s|$)|stash\s+(?:drop|clear)|branch\s+-D\b|worktree\s+remove\b[^;|&]*--force)`),
    reason: "Discards uncommitted work or deletes a branch that may not be merged.",
    fix: "Run `git status` / `git stash` first and confirm nothing needed is lost.",
  },
  {
    id: "GIT-NO-VERIFY",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}(?:commit|push|merge|rebase|am)\b[^;|&]*--no-verify`),
    reason: "Skips git hooks (secret scanning, linting, tests).",
    fix: "Fix what the hook reports instead of bypassing it.",
  },
  {
    id: "GIT-ADD-SECRET",
    level: "deny",
    re: r(String.raw`${CLI}git${SP}add\b[^;|&]*(?:(?:^|\s|/)\.env(?:\.(?!example|sample|template|dist)[\w-]+)?(?:\s|$)|\.pem\b|\.pfx\b|\.p12\b|\.key(?:\s|$)|\.tfstate\b|\.tfvars(?:\s|$)|(?:^|\s|/)id_(?:rsa|ecdsa|ed25519)(?:\s|$)|credentials(?:\.json)?(?:\s|$)|\.npmrc\b|\.pypirc\b|kubeconfig\b)`),
    reason: "Stages a file that normally holds secrets (.env, keys, state, tfvars, credentials).",
    fix: "Add the file to .gitignore, commit an example file without values, keep real values in a secret manager.",
  },
  {
    id: "GIT-ADD-FORCE",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}add\b[^;|&]*\s(?:-f|--force)\b`),
    reason: "Force-adds a file that .gitignore excludes.",
    fix: "Check why the file is ignored before committing it.",
  },
  {
    id: "GIT-CONFIG-GLOBAL",
    level: "ask",
    re: r(String.raw`${CLI}git${SP}config\b[^;|&]*--(?:global|system)\b(?![^;|&]*--(?:get|list|get-all)\b)`),
    reason: "Changes git configuration for every repository on the machine (identity, hooks path, credential helper).",
    fix: "Use repository-local config, or ask the human to change their global config.",
  },
  {
    id: "GH-ADMIN",
    level: "deny",
    re: r(String.raw`${CLI}gh${SP}(?:repo\s+(?:delete|archive|rename)|repo\s+edit\b[^;|&]*--visibility\s+public|pr\s+merge\b[^;|&]*--admin|api\b[^;|&]*(?:-x|--method)\s+delete|api\b[^;|&]*/protection\b[^;|&]*(?:-x|--method)\s+(?:put|patch|delete)|secret\s+(?:delete|remove)|ruleset\s+delete|release\s+delete)`),
    reason: "Deletes or exposes a repository, bypasses branch protection, or changes protection/secrets/releases.",
    fix: "Repository administration is done by maintainers in GitHub settings or via reviewed IaC.",
  },
  {
    id: "GH-SECRET-SET",
    level: "ask",
    re: r(String.raw`${CLI}gh${SP}(?:secret|variable)\s+set\b`),
    reason: "Creates or changes a CI secret or variable.",
    fix: "Prefer OIDC federation over stored secrets (cicd-oidc); never pass the value on the command line.",
  },

  // ───────────────────────── Databases ─────────────────────────
  {
    id: "DB-PASSWORD-LITERAL",
    level: "deny",
    re: r(String.raw`(?:(?:^|\s)(?:pgpassword|mysql_pwd|mssql_password|sqlcmdpassword|rediscli_auth)=[^\s$]|${CLI}(?:mysql|mariadb|mysqldump|mysqladmin)\b[^;|&]*\s-p[^\s-]|--password=[^\s$]|${CLI}sqlcmd\b[^;|&]*\s-p\s+[^\s$]|${CLI}redis-cli\b[^;|&]*\s(?:-a|--pass)\s+[^\s$]|${CLI}sqlplus\s+\w+/[^@\s$]+@|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|sqlserver|mssql|jdbc:\w+):\/\/[^:/\s@]+:[^@\s$]+@)`),
    reason: "Puts a database password on the command line or in a connection string, exposing it in shell history, process lists and the transcript.",
    fix: "Use IAM/Entra/IAM-database auth, a .pgpass/option file managed by the human, or a secret manager injected at runtime.",
  },
  {
    id: "DB-DROP-DATABASE",
    level: "deny",
    re: r(String.raw`${DBCLI}(?:\bdrop\s+(?:database|schema|keyspace|tablespace|user|role|login)\b|\bdropdatabase\s*\(|${CLI}(?:dropdb|dropuser)\b|${CLI}mysqladmin\b[^;|&]*\bdrop\b)`),
    reason: "Drops a whole database, schema, keyspace, user or role.",
    fix: "Database and account removal is a DBA change with a backup and approval, executed outside the agent.",
  },
  {
    id: "DB-UNBOUNDED-WRITE",
    level: "deny",
    re: r(String.raw`${DBCLI}(?:\bdelete\s+from\s+[\w.\[\]$"]+\s*(?:;|$|\)|\\n)|\bdelete\s+[\w.\[\]]+\s*(?:;|$)|\bupdate\s+[\w.\[\]$"]+\s+set\s+(?:(?!\bwhere\b)[^;])*(?:;|$)|\.(?:deletemany|remove|updatemany)\s*\(\s*\{\s*\}|\.drop\s*\(\s*\))`),
    reason: "Deletes or updates every row/document (no WHERE clause / empty filter) or drops a collection.",
    fix: "Add an explicit WHERE / filter, run the matching SELECT/count first, wrap in a transaction, and get approval with the expected row count.",
  },
  {
    id: "DB-DESTRUCTIVE-DDL",
    level: "ask",
    re: r(String.raw`${DBCLI}(?:\b(?:drop\s+(?:table|view|index|collection|materialized\s+view|function|procedure|trigger|sequence|type|extension)|truncate\s+(?:table\s+)?[\w.]|alter\s+table\s+[\w.\[\]"]+\s+drop\b|alter\s+system\b))`),
    reason: "Drops objects, truncates data, drops columns or changes server-wide settings.",
    fix: "Ship it as a reviewed migration (db-migrations) with a backup and rollback; never ad hoc in prod.",
  },
  {
    id: "DB-PRIV-ESCALATE",
    level: "deny",
    re: r(String.raw`${DBCLI}(?:\bgrant\s+all\b|\bgrant\b[^;]*\bto\s+public\b|\b(?:create|alter)\s+(?:user|role)\b[^;]*\b(?:superuser|createrole|bypassrls|replication)\b|\bwith\s+grant\s+option\b|\bgrant\s+(?:super|file|process|shutdown)\b|\bsp_addsrvrolemember\b|\balter\s+server\s+role\s+sysadmin\b|\bgrant\s+control\s+server\b|\bsp_configure\s+.?xp_cmdshell|role\s*:\s*(?:root|dbowner|userAdminAnyDatabase|dbAdminAnyDatabase|clusterAdmin)\b|\bgrant\s+dba\b)`),
    reason: "Grants superuser / admin / all privileges, or enables OS command execution from the database.",
    fix: "Grant the narrow role the application needs (db-access-control) through reviewed migrations or IaC.",
  },
  {
    id: "DB-REDIS-DESTRUCT",
    level: "deny",
    re: r(String.raw`${CLI}redis-cli\b[^;|&]*\s(?:flushall|flushdb|shutdown|debug\s+\w+|config\s+set\s+(?:dir|dbfilename|requirepass|protected-mode)|slaveof|replicaof|module\s+load|acl\s+(?:deluser|setuser\b[^;|&]*\+@all))\b`),
    reason: "Wipes Redis data, shuts it down, re-points replication or changes security-critical config.",
    fix: "Delete specific keys by pattern with a reviewed script (SCAN + UNLINK) and approval; config changes go through IaC.",
  },
  {
    id: "DB-DATA-EXPORT",
    level: "ask",
    re: r(String.raw`${CLI}(?:pg_dump|pg_dumpall|mysqldump|mongodump|mongoexport|bcp|expdp|exp|sqlpackage)\b|\bcopy\b[^;]*\bto\s+(?:stdout|program|'|/)|\binto\s+outfile\b|\bselect\b[^;]*\binto\s+dumpfile\b|${CLI}redis-cli\b[^;|&]*--rdb\b`),
    reason: "Exports database contents (may include personal or confidential data) to a file or stdout.",
    fix: "Export only the tables/columns needed, from nonprod or a masked copy, to an approved location.",
  },
  {
    id: "DB-RESTORE-OVERWRITE",
    level: "ask",
    re: r(String.raw`${CLI}(?:pg_restore|mongorestore|impdp|imp)\b|${CLI}pg_restore\b[^;|&]*(?:--clean|-c\b)|${CLI}mongorestore\b[^;|&]*--drop`),
    reason: "Restores data, possibly dropping and replacing existing objects.",
    fix: "Restore into a new database and validate before switching (cloud-dr-backup).",
  },

  // ───────────────────────── Packages, publishing and shell ─────────────────────────
  {
    id: "PKG-PUBLISH",
    level: "ask",
    re: r(String.raw`${CLI}(?:npm|pnpm|yarn|bun)${SP}(?:publish|unpublish|deprecate|dist-tag\s+(?:add|rm))\b|${CLI}yarn\s+npm\s+publish\b|${CLI}(?:mvn|mvnw|\./mvnw)\b[^;|&]*\bdeploy\b|${CLI}(?:gradle|gradlew|\./gradlew)\b[^;|&]*\bpublish\w*\b|${CLI}twine\s+upload\b|${CLI}(?:poetry|uv|hatch|flit)\s+publish\b|${CLI}cargo\s+(?:publish|yank)\b|${CLI}dotnet\s+nuget\s+(?:push|delete)\b|${CLI}gem\s+(?:push|yank)\b|${CLI}(?:docker|podman)\s+(?:push|image\s+push)\b|${CLI}helm\s+push\b|${CLI}go\s+mod\s+retract\b`),
    reason: "Publishes or retracts a package or image to a registry, which other teams and customers may consume immediately.",
    fix: "Release through the CI pipeline with versioning, signing and approvals.",
  },
  {
    id: "PKG-UNPUBLISH",
    level: "deny",
    re: r(String.raw`${CLI}npm${SP}unpublish\b[^;|&]*--force|${CLI}(?:npm|pnpm)${SP}owner\s+(?:add|rm)\b|${CLI}npm${SP}access\s+(?:public|grant)\b`),
    reason: "Force-unpublishes a package or changes package ownership/visibility.",
    fix: "Package ownership and visibility are maintainer decisions.",
  },
  {
    id: "SHELL-RM-ROOT",
    level: "deny",
    re: r(String.raw`(?:^|[;&|]\s*|\s)(?:sudo\s+)?rm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*(?:--no-preserve-root\s+)?(?:/|/\*|~|~/|~/\*|\$home|\$home/|\$home/\*|\.|\./|\./\*|\*|\.\.|\.\./|/home|/users|/etc|/var|/usr|c:\\?|c:/)(?:\s|$)|remove-item\b[^;|&]*-recurse\b[^;|&]*\s(?:c:\\?|c:/|~|\$home|\$env:userprofile)(?:\s|$)|${CLI}(?:mkfs(?:\.\w+)?|format\s+[a-z]:|diskpart)\b|\bdd\b[^;|&]*\bof=/dev/(?:sd|nvme|hd|disk)|:\(\)\s*\{\s*:\|:&\s*\};:`),
    reason: "Recursively deletes the filesystem root, home directory, the whole working tree or a system directory, or wipes a disk.",
    fix: "Delete specific build paths (e.g. `rm -rf ./dist`) after listing them.",
  },
  {
    id: "SHELL-PERMS",
    level: "ask",
    re: r(String.raw`${CLI}chmod\b[^;|&]*\b(?:-r\s+)?(?:777|a\+rwx|o\+w)\b|${CLI}chown\b[^;|&]*\s-r\b[^;|&]*\s/(?:\s|$)|${CLI}icacls\b[^;|&]*everyone:\(?f`),
    reason: "Makes files world-writable or recursively changes ownership of system paths.",
    fix: "Grant the narrowest permission to the specific user or group.",
  },
  {
    id: "SHELL-SUDO",
    level: "ask",
    re: r(String.raw`(?:^|[;&|]\s*)(?:sudo|doas|runas|gsudo)\s`),
    reason: "Runs a command with administrator privileges.",
    fix: "Explain why elevation is needed; the human runs it if appropriate.",
  },

  // ───────────────────────── Shell-level destruction ─────────────────────────
  {
    id: "SHELL-RM-STATE",
    level: "deny",
    re: r(String.raw`(?:rm|del|remove-item|rmdir|rd)\b[^;|&]*(?:\.tfstate\b|\.terraform[\\/]?(?:\s|$)|terraform\.tfstate\.d|\.pulumi[\\/]|cdk\.out[\\/]?\s*$|\.aws\b|\.azure\b|\.config[\\/]gcloud|\.kube\b|\.cloud-guard\b)`),
    reason: "Deletes Terraform/Pulumi state, cloud CLI config or the guard itself.",
    fix: "State is managed by the remote backend. The guard can only be changed by a human.",
  },
  {
    id: "GUARD-TAMPER",
    level: "deny",
    re: r(String.raw`(?:\.cloud-guard[\\/](?:policy\.json|bin[\\/])|\.claude[\\/]settings(?:\.local)?\.json|\.cursor[\\/]hooks\.json|\.gemini[\\/]settings\.json)[^;|&]*(?:>|tee\b|sed\s+-i|set-content|out-file|mv\b|cp\b)|(?:>|tee\s|sed\s+-i|set-content|out-file|\bmv\s|\bcp\s|\brm\s|\bdel\s)[^;|&]*(?:\.cloud-guard[\\/](?:policy\.json|bin[\\/])|\.claude[\\/]settings(?:\.local)?\.json|\.cursor[\\/]hooks\.json|\.gemini[\\/]settings\.json)`),
    reason: "Modifies the guard policy or the agent's hook configuration from inside the agent.",
    fix: "Only a human edits the guard policy and hook settings. Ask them to make the change.",
  },
];

// Paths an agent must never read or write through file tools (Read/Write/Edit),
// in addition to shell access covered by SECRET-CRED-FILE-READ.
export const PROTECTED_PATHS = [
  { id: "PATH-CRED-STORE", re: /(?:^|[\\/])(?:\.aws[\\/](?:credentials|config)|\.azure[\\/]|\.config[\\/]gcloud[\\/]|gcloud[\\/](?:credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials)|\.kube[\\/]config|\.docker[\\/]config\.json|\.terraform\.d[\\/]credentials|\.terraformrc|\.netrc|\.npmrc|\.pgpass|\.ssh[\\/])/i, reason: "Local credential store." },
  { id: "PATH-STATE", re: /\.tfstate(?:\.backup)?$|terraform\.tfstate\.d[\\/]|\.pulumi[\\/]stacks[\\/]/i, reason: "IaC state files contain secrets in clear text." },
  { id: "PATH-DOTENV", re: /(?:^|[\\/])\.env(?:\.(?!example$|sample$|template$|dist$)[\w-]+)?$|(?:^|[\\/])\.(?:pypirc|pgpass|my\.cnf)$|(?:^|[\\/])(?:secrets?|credentials?)\.(?:ya?ml|json|toml|ini)$/i, reason: "Environment / secrets file with real values." },
  { id: "PATH-KEYS", re: /\.(?:pem|pfx|p12|key|jks|keystore|ppk)$|(?:^|[\\/])id_(?:rsa|ecdsa|ed25519|dsa)(?:\.pub)?$|-[0-9a-f]{12}\.json$|service[-_]?account[^\\/]*\.json$|credentials?\.json$/i, reason: "Private key or service-account key file." },
];

// Write-only protection: the agent may read these but not change them.
export const GUARD_PATHS = /(?:^|[\\/])\.cloud-guard[\\/](?:policy\.json|bin[\\/])|(?:^|[\\/])\.claude[\\/]settings(?:\.local)?\.json$|(?:^|[\\/])\.cursor[\\/]hooks\.json$|(?:^|[\\/])\.gemini[\\/]settings\.json$/i;

// Secret material that must not be written into files by an agent.
// Each entry: { id, re, reason }. Matches are case-sensitive where the token format is.
export const SECRET_CONTENT = [
  { id: "SECRET-AWS-KEY-PAIR", re: /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)(?!IOSFODNN7EXAMPLE)[A-Z0-9]{16}[\s\S]{0,200}?[A-Za-z0-9/+=]{40}/, reason: "AWS access key id with a secret key." },
  { id: "SECRET-AWS-SECRET", re: /aws_secret_access_key\s*[=:]\s*["']?(?!wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY)[A-Za-z0-9/+=]{40}/i, reason: "AWS secret access key." },
  { id: "SECRET-PRIVATE-KEY", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, reason: "Private key material." },
  { id: "SECRET-GCP-SA-KEY", re: /"type"\s*:\s*"service_account"[\s\S]{0,2000}"private_key"\s*:\s*"-----BEGIN/, reason: "Google service-account key JSON." },
  { id: "SECRET-AZ-STORAGE-KEY", re: /AccountKey=[A-Za-z0-9+/]{80,}={0,2}/, reason: "Azure storage account key / connection string." },
  { id: "SECRET-AZ-SAS", re: /[?&]sig=[A-Za-z0-9%+/]{40,}={0,2}/, reason: "Azure SAS token signature." },
  { id: "SECRET-AZ-CLIENT-SECRET", re: /\b[a-zA-Z0-9_~.-]{3}\dQ~[a-zA-Z0-9_~.-]{31,34}\b/, reason: "Entra ID (Azure AD) client secret." },
  { id: "SECRET-AZ-CONN", re: /(?:SharedAccessKey|AccountEndpoint=[^;]+;AccountKey|Password)=[A-Za-z0-9+/]{30,}={0,2}/, reason: "Azure connection string with a key." },
  { id: "SECRET-GCP-API-KEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: "Google API key." },
  { id: "SECRET-GITHUB", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, reason: "GitHub token." },
  { id: "SECRET-SLACK", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, reason: "Slack token." },
  { id: "SECRET-OPENAI", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/, reason: "AI provider API key." },
  { id: "SECRET-JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, reason: "Bearer token (JWT)." },
  { id: "SECRET-HARDCODED-PASSWORD", re: /\b(?:password|passwd|admin_password|master_password|client_secret|db_password)\s*[:=]\s*"(?!\$\{|var\.|local\.|data\.|random_|ephemeral\.|<|CHANGE|REPLACE|TODO|example|\*{3})[^"\s]{8,}"/i, reason: "Hard-coded password / client secret in code or config." },
];
