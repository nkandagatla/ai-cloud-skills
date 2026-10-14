---
name: aws-serverless
description: Build and operate AWS serverless applications - Lambda (roles, packaging, versions/aliases, concurrency, VPC, layers, function URLs), API Gateway (REST/HTTP, authorizers, WAF, throttling), Step Functions, EventBridge, SQS/SNS (DLQs, idempotency), with SAM/CDK/Terraform deployment and troubleshooting. Use for serverless architectures, Lambda errors/timeouts/throttles, or API Gateway issues.
---

# AWS Serverless

Load `cloud-guardrails`. Serverless code is deployed by IaC (SAM, CDK, Terraform, Serverless Framework). Deploy to nonprod with approval; prod via pipeline with gradual traffic shifting.

## 1. Lambda baseline

- **One role per function**, scoped to exact resources. No `AWSLambda_FullAccess`, no `*`.
- **Secrets** from Secrets Manager / Parameter Store at runtime (Parameters and Secrets Lambda Extension caches them); never in environment variables in plain text. If env vars hold non-secret config, KMS-encrypt with a CMK if classification requires.
- **Runtimes**: supported versions only; `arm64` where compatible.
- **Versions + aliases** (`live`) and CodeDeploy traffic shifting (`Canary10Percent5Minutes` / `Linear10PercentEvery1Minute`) with CloudWatch alarms for automatic rollback.
- **Concurrency**: reserved concurrency to protect downstream systems; provisioned concurrency only where latency demands (cost).
- **Timeouts** shorter than the caller's timeout (API Gateway max 29 s by default); memory tuned (Lambda Power Tuning).
- **Async**: on-failure destinations or DLQ; `MaximumRetryAttempts` and `MaximumEventAgeInSeconds` set deliberately.
- **Idempotency**: Powertools for AWS Lambda idempotency utility (DynamoDB-backed) for any event that can be retried.
- **Observability**: Powertools logger/metrics/tracer, structured JSON logs, X-Ray or OpenTelemetry, log retention set on `/aws/lambda/<fn>`.
- **VPC**: only when the function must reach private resources; use VPC endpoints / NAT for AWS APIs.
- **Code signing** (AWS Signer) for regulated workloads.
- **Function URLs**: `AWS_IAM` auth by default. `NONE` requires explicit justification and a reviewer (public endpoint).

SAM snippet:

```yaml
Resources:
  OrdersFn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: python3.12
      Architectures: [arm64]
      Handler: app.handler
      CodeUri: src/
      Timeout: 10
      MemorySize: 512
      ReservedConcurrentExecutions: 50
      AutoPublishAlias: live
      DeploymentPreference:
        Type: Canary10Percent5Minutes
        Alarms: [!Ref OrdersErrorsAlarm]
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref OrdersTable }
      Environment:
        Variables:
          TABLE_NAME: !Ref OrdersTable
          POWERTOOLS_SERVICE_NAME: orders
      DeadLetterQueue: { Type: SQS, TargetArn: !GetAtt OrdersDLQ.Arn }
```

## 2. API Gateway

- Prefer **HTTP API** for simple JWT/Lambda proxies; **REST API** when you need WAF, usage plans/API keys for metering, request validation, private APIs, or resource policies.
- Authorization: JWT authorizer (Cognito / OIDC IdP) or Lambda authorizer; IAM auth for service-to-service. No unauthenticated routes except deliberate public ones.
- Throttling per stage/route; WAF (REST, or HTTP via CloudFront); request validation and payload size limits.
- Access logs to CloudWatch with a JSON format including `requestId`, `status`, `integrationErrorMessage`.
- Custom domain with TLS 1.2+ security policy; disable the default `execute-api` endpoint when using a custom domain.
- Private APIs for internal services, with resource policy limited to `aws:SourceVpce`.

## 3. Events and messaging

- **SQS**: DLQ with `maxReceiveCount` 3-5; visibility timeout ≥ 6 × function timeout for Lambda event source; partial batch responses (`ReportBatchItemFailures`); SSE-SQS/KMS; queue policy scoped with `aws:SourceArn`.
- **SNS**: subscription filter policies; DLQ on subscriptions; topic policy scoped; KMS encryption.
- **EventBridge**: specific event patterns, DLQ on targets, archive + replay for critical buses, resource policy for cross-account buses scoped to org.
- **Step Functions**: Standard for long/auditable, Express for high-volume; retries with backoff + `Catch` to failure states; least-privilege role; logging level `ERROR` minimum with execution data excluded if sensitive.

## 4. Read-only troubleshooting

```bash
aws lambda get-function-configuration --function-name F --query "{rt:Runtime,mem:MemorySize,timeout:Timeout,role:Role,vpc:VpcConfig.SubnetIds,ver:Version,state:State,last:LastUpdateStatus}"
aws lambda get-alias --function-name F --name live
aws lambda get-function-concurrency --function-name F
aws logs tail /aws/lambda/F --since 30m --filter-pattern "?ERROR ?Task timed out ?Runtime.ExitError"
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Throttles --dimensions Name=FunctionName,Value=F --start-time $(date -u -d '-1 hour' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300 --statistics Sum
aws lambda get-event-source-mapping --uuid UUID      # state, batch size, last processing result
aws sqs get-queue-attributes --queue-url URL --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws apigatewayv2 get-routes --api-id API ; aws apigateway get-stages --rest-api-id API
```

| Symptom | Likely cause |
| --- | --- |
| `Task timed out` | Downstream latency, VPC without endpoint/NAT (hangs on AWS SDK calls), timeout too low |
| Throttles | Account concurrency limit, reserved concurrency too low, burst |
| `AccessDeniedException` | Execution role, KMS key policy, resource policy |
| API 502 | Lambda response format wrong for proxy integration, unhandled exception |
| API 504 | Integration > 29 s |
| API 403 | Authorizer denial, WAF block, resource policy, missing `x-api-key`, wrong stage/path |
| SQS messages piling in DLQ | Poison message; inspect a sample **with approval** (may contain PII), fix, then redrive (`start-message-move-task`) |
| Duplicate processing | No idempotency, visibility timeout too short |

Invoking functions (`aws lambda invoke`) runs code with real side effects: it is a change unless the function is proven read-only.

## Never

- Use `--principal '*'` in `lambda add-permission` or `Principal: *` in queue/topic policies without conditions (guard-blocked).
- Store secrets in Lambda environment variables or code.
- Purge queues or DLQs in prod (data loss) or redrive without understanding the failure.
- Deploy prod by `sam deploy --no-confirm-changeset` / `cdk deploy --require-approval never` (guard-blocked).
