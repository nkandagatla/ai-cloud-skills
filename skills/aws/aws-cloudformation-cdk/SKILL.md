---
name: aws-cloudformation-cdk
description: Author, review and deploy AWS CloudFormation, SAM and CDK safely - change sets, stack policies, termination protection, drift detection, StackSets, cdk diff/synth, cdk-nag, bootstrap security, rollback and recovery from UPDATE_ROLLBACK_FAILED. Use when working with CloudFormation templates, CDK apps or SAM deployments.
---

# AWS CloudFormation and CDK

Load `cloud-guardrails`, `cloud-change-plan`, `iac-security-review`. Agents synthesise, lint, diff and create change sets. Agents never execute change sets in prod, never deploy with approvals disabled, never delete stacks.

## 1. Template hygiene

- Parameters with `AllowedValues`/`AllowedPattern`; `NoEcho: true` for secrets (better: dynamic references `{{resolve:secretsmanager:prod/db:SecretString:password}}`, never default values).
- `DeletionPolicy: Retain` / `Snapshot` and `UpdateReplacePolicy: Retain`/`Snapshot` on stateful resources (buckets, tables, databases, KMS keys, log groups).
- No hard-coded account ids/regions: `AWS::AccountId`, `AWS::Region`, `AWS::Partition`.
- Outputs never contain secrets.
- Lint and scan: `cfn-lint`, `cfn-guard validate -r rules/`, `checkov -f template.yaml`, `cfn_nag_scan`.

## 2. Stack protections (prod)

- **Termination protection** on: `aws cloudformation update-termination-protection --enable-termination-protection --stack-name S` (disabling is guard-blocked).
- **Stack policy** denying `Update:Replace` / `Update:Delete` on data resources:

```json
{
  "Statement": [
    { "Effect": "Allow", "Action": "Update:*", "Principal": "*", "Resource": "*" },
    { "Effect": "Deny", "Action": ["Update:Replace", "Update:Delete"], "Principal": "*",
      "Resource": "LogicalResourceId/OrdersTable" }
  ]
}
```
- Service role for deployments (`--role-arn`) scoped to what the stack manages; humans and CI do not need those permissions directly.
- Rollback triggers (CloudWatch alarms) and `--disable-rollback` **off**.

## 3. Change-set workflow

```bash
aws cloudformation validate-template --template-body file://template.yaml
aws cloudformation create-change-set --stack-name S --change-set-name cs-$(date +%s) \
  --template-body file://template.yaml --parameters file://params-dev.json \
  --capabilities CAPABILITY_NAMED_IAM --include-nested-stacks
aws cloudformation wait change-set-create-complete --stack-name S --change-set-name NAME
aws cloudformation describe-change-set --stack-name S --change-set-name NAME \
  --query "Changes[].ResourceChange.{action:Action,id:LogicalResourceId,type:ResourceType,replace:Replacement,scope:Scope}" --output table
```

Flag every `Replacement: True` / `Conditional` and every `Remove`. Present per `cloud-change-plan`. Execution (`execute-change-set`) in nonprod after approval; prod via pipeline. Validate IAM changes with `CAPABILITY_*` awareness: acknowledging capabilities means the stack creates IAM.

## 4. CDK

```bash
npx cdk synth                       # renders CloudFormation into cdk.out
npx cdk diff --context env=dev      # what would change
npx cdk deploy MyStack-dev          # interactive approval for security-relevant changes (default "broadening")
```

- Keep `requireApproval` at `broadening` (default) or `any-change`; never `never` (guard-blocked).
- **cdk-nag** (`Aspects.of(app).add(new AwsSolutionsChecks())`) in the app; suppressions with reasons only.
- Pin `aws-cdk-lib` and construct libraries; commit `package-lock.json`; feature flags in `cdk.json` reviewed on upgrade.
- Environments explicit: `new Stack(app, 'Orders-prod', { env: { account: '111122223333', region: 'us-east-1' } })`.
- `RemovalPolicy.RETAIN` / `SNAPSHOT` for stateful constructs (CDK default for many is RETAIN; check `autoDeleteObjects` is false in prod).
- **Bootstrap security**: `cdk bootstrap --trust <pipeline-account> --cloudformation-execution-policies arn:aws:iam::ACCOUNT:policy/cdk-exec-scoped` (not `AdministratorAccess` in prod); custom bootstrap template with permission boundary; bootstrapping is a platform-team change.
- Unit tests with `aws-cdk-lib/assertions` (`Template.fromStack(...).hasResourceProperties(...)`) for security properties.

## 5. SAM

`sam validate --lint`, `sam build`, `sam deploy --no-execute-changeset` to review, `--confirm-changeset` interactive. `samconfig.toml` per environment; no secrets in it.

## 6. StackSets

Service-managed permissions with Organizations; deploy to OUs; `FailureTolerance` and `MaxConcurrent` low (1 region / 10% accounts) for guardrail stacks; drift detection on schedule. StackSet changes reach many accounts: platform team only.

## 7. Drift and recovery

```bash
aws cloudformation detect-stack-drift --stack-name S          # starts a drift detection (read-only on resources)
aws cloudformation describe-stack-resource-drifts --stack-name S --stack-resource-drift-status-filters MODIFIED DELETED
aws cloudformation describe-stack-events --stack-name S --max-items 30 --query "StackEvents[].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]" --output text
```

| State | What to do |
| --- | --- |
| `UPDATE_ROLLBACK_FAILED` | Read events for the failing resource; fix the cause (often a manually deleted/changed resource or permissions); `continue-update-rollback`, optionally `--resources-to-skip` (human decision: skipped resources go out of sync) |
| `ROLLBACK_COMPLETE` (create failed) | Stack must be deleted before re-create: confirm nothing stateful was created; human approval |
| Drifted resources | Codify the change in the template, or revert it; use **resource import** to adopt existing resources |
| Stuck `*_IN_PROGRESS` | Usually waiting on a resource (ECS service stabilisation, custom resource); check the resource itself, not the stack |

## Never

- `delete-stack` from an agent; disable termination protection (guard-blocked); `--disable-rollback` in prod.
- `cdk deploy --require-approval never`, `cdk destroy --force`, `sam deploy --no-confirm-changeset` (guard-blocked).
- Put secrets in parameters defaults, `cdk.json`, context, or template literals.
