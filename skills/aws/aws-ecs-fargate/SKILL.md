---
name: aws-ecs-fargate
description: Build, deploy and troubleshoot containers on Amazon ECS (Fargate and EC2) - task definitions with task/execution roles, secrets injection, awsvpc networking, service deployments (rolling, circuit breaker, blue/green), ECS Exec, autoscaling and logging. Use for ECS services, task definitions, deployment failures or stopped tasks.
---

# Amazon ECS on Fargate

Load `cloud-guardrails`. Deploy by registering a new task definition revision and updating the service through IaC or the pipeline; roll back by pointing the service at the previous revision.

## 1. Secure task definition

```json
{
  "family": "orders-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512", "memory": "1024",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::111122223333:role/orders-api-exec",
  "taskRoleArn": "arn:aws:iam::111122223333:role/orders-api-task",
  "containerDefinitions": [{
    "name": "api",
    "image": "111122223333.dkr.ecr.us-east-1.amazonaws.com/orders-api@sha256:<digest>",
    "essential": true,
    "user": "10001",
    "readonlyRootFilesystem": true,
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "secrets": [
      { "name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/orders/db-AbCdEf:password::" }
    ],
    "environment": [{ "name": "LOG_LEVEL", "value": "info" }],
    "logConfiguration": { "logDriver": "awslogs", "options": { "awslogs-group": "/ecs/orders-api", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "api" } },
    "healthCheck": { "command": ["CMD-SHELL", "wget -qO- http://localhost:8080/healthz || exit 1"], "interval": 15, "retries": 3, "startPeriod": 30 },
    "linuxParameters": { "capabilities": { "drop": ["ALL"] }, "initProcessEnabled": true }
  }]
}
```

- **Execution role**: pull from ECR, write logs, read the specific secrets/parameters (and `kms:Decrypt` for their key). **Task role**: only what the app needs at runtime. Never the same role.
- Secrets via `secrets` (`valueFrom` ARN), never `environment` values.
- Image by digest; images scanned and signed (`container-supply-chain`).

## 2. Service settings

- Private subnets, `assignPublicIp = DISABLED`, SG allowing only the LB.
- `deploymentCircuitBreaker { enable = true, rollback = true }`, `minimumHealthyPercent = 100`, `maximumPercent = 200` in prod; deployment alarms for automatic rollback.
- Blue/green: ECS native blue/green deployments or CodeDeploy, with test listener and bake time.
- Service Auto Scaling: target tracking on CPU / `ALBRequestCountPerTarget`; sane min (≥ 2 in prod across AZs) and max.
- `enableExecuteCommand` only where needed; ECS Exec sessions are logged (KMS-encrypted, S3/CloudWatch) and need `ssmmessages` access.
- Container Insights (enhanced observability) on the cluster.
- Capacity providers: `FARGATE` for prod baseline, `FARGATE_SPOT` for tolerant workloads.

## 3. Read-only operations

```bash
aws ecs list-services --cluster C
aws ecs describe-services --cluster C --services S --query "services[].{desired:desiredCount,running:runningCount,pending:pendingCount,td:taskDefinition,deployments:deployments[].[status,rolloutState,taskDefinition,failedTasks]}"
aws ecs describe-services --cluster C --services S --query "services[].events[:10].[createdAt,message]" --output text
aws ecs list-tasks --cluster C --service-name S --desired-status STOPPED
aws ecs describe-tasks --cluster C --tasks T --query "tasks[].{stopped:stoppedReason,code:stopCode,containers:containers[].[name,exitCode,reason]}"
aws logs tail /ecs/orders-api --since 30m --follow=false
aws ecs describe-task-definition --task-definition orders-api --query "taskDefinition.{rev:revision,image:containerDefinitions[0].image,cpu:cpu,mem:memory}"
```

Do not print full task definitions in chat if they contain environment values; `secrets` show only ARNs (fine).

## 4. Deploy and roll back (nonprod with approval; prod through the pipeline)

```bash
aws ecs register-task-definition --cli-input-json file://taskdef.json        # new revision
aws ecs update-service --cluster C --service S --task-definition orders-api:42
aws ecs wait services-stable --cluster C --services S
# rollback
aws ecs update-service --cluster C --service S --task-definition orders-api:41
```

## 5. Troubleshooting stopped tasks

| `stoppedReason` / symptom | Cause / check |
| --- | --- |
| `CannotPullContainerError` | ECR permissions on execution role, VPC endpoints/NAT, image tag/digest exists, cross-region |
| `ResourceInitializationError: unable to pull secrets` | Execution role lacks `secretsmanager:GetSecretValue`/`ssm:GetParameters`/`kms:Decrypt` for that ARN; endpoints for secretsmanager/ssm |
| `Essential container in task exited` | App logs; exit code 137 = OOM (raise memory or fix leak), 1 = app error |
| Health checks failing | Container health check command exists in image (distroless has no shell), ALB health path, startPeriod |
| Deployment stuck | Circuit breaker events; capacity (ENI/IP limits in subnets); placement constraints |
| Tasks killed by ALB | Health check grace period too short |

## Never

- Put secrets in `environment`, task definition JSON in git, or image layers.
- Run tasks with `privileged` (EC2 launch type) or as root without justification.
- Give the task role `*` permissions or share roles across services.
- Enable ECS Exec on prod services as a debugging shortcut without approval and session logging.
