---
name: aws-ec2-autoscaling
description: Operate EC2 and Auto Scaling groups safely - launch templates, AMIs and golden images, IMDSv2, EBS encryption, SSM Session Manager/Patch Manager/Run Command, instance refresh, scaling policies, Spot/Graviton, and troubleshooting unhealthy or unreachable instances. Use for EC2/ASG builds, patching, scaling, or instance issues.
---

# AWS EC2 and Auto Scaling

Load `cloud-guardrails`. Treat instances as **cattle**: changes go into the launch template / AMI and roll out via instance refresh, not by SSH-ing in and editing.

## 1. Secure launch template baseline

```hcl
resource "aws_launch_template" "app" {
  name_prefix   = "app-"
  image_id      = data.aws_ssm_parameter.golden_ami.value   # from your image pipeline
  instance_type = "m7g.large"                               # Graviton where compatible
  iam_instance_profile { arn = aws_iam_instance_profile.app.arn }   # least-privilege role, includes AmazonSSMManagedInstanceCore
  vpc_security_group_ids = [aws_security_group.app.id]
  metadata_options {
    http_tokens                 = "required"   # IMDSv2 only
    http_put_response_hop_limit = 1            # 2 if containers on the host need IMDS
    http_endpoint               = "enabled"
    instance_metadata_tags      = "disabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs { volume_type = "gp3", volume_size = 30, encrypted = true, kms_key_id = var.ebs_kms_key_arn, delete_on_termination = true }
  }
  monitoring { enabled = true }
  update_default_version = true
  user_data = base64encode(templatefile("${path.module}/user_data.sh", { env = var.env }))  # no secrets in user data
  tag_specifications { resource_type = "instance"  tags = local.tags }
}
```

No key pairs (`key_name`) unless there is a documented exception; SSM Session Manager replaces SSH. No public IP. User data fetches secrets at runtime from Secrets Manager / SSM with the instance role.

## 2. Auto Scaling group

- Span ≥ 2 AZs (3 in prod); `health_check_type = "ELB"` behind a load balancer, grace period realistic.
- `min_size` ≥ 2 in prod; `max_size` bounded (cost guard).
- Target tracking on `ASGAverageCPUUtilization` or `ALBRequestCountPerTarget`; predictive scaling for regular patterns.
- Mixed instances policy for Spot in nonprod / stateless tiers (capacity-optimized allocation, several instance types).
- Lifecycle hooks for graceful drain / bootstrap.
- Instance refresh with `min_healthy_percentage` 90+, checkpoints, auto-rollback + alarm-based rollback.
- Warm pools for slow-booting apps.

## 3. Read-only operations

```bash
aws ec2 describe-instances --filters Name=tag:app,Values=checkout Name=instance-state-name,Values=running \
  --query "Reservations[].Instances[].{id:InstanceId,type:InstanceType,az:Placement.AvailabilityZone,ip:PrivateIpAddress,imds:MetadataOptions.HttpTokens,launched:LaunchTime}" --output table
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ASG --query "AutoScalingGroups[].{min:MinSize,max:MaxSize,desired:DesiredCapacity,instances:Instances[].[InstanceId,HealthStatus,LifecycleState]}"
aws autoscaling describe-scaling-activities --auto-scaling-group-name ASG --max-items 10
aws autoscaling describe-instance-refreshes --auto-scaling-group-name ASG
aws ec2 describe-instance-status --instance-ids ID --include-all-instances
aws ec2 get-console-output --instance-id ID --latest --output text | tail -50
aws ssm describe-instance-information --query "InstanceInformationList[].{id:InstanceId,ping:PingStatus,agent:AgentVersion,platform:PlatformName}"
aws ec2 describe-instances --query "Reservations[].Instances[?MetadataOptions.HttpTokens=='optional'].InstanceId"   # IMDSv1 still allowed
```

## 4. Changes

| Task | Safe approach |
| --- | --- |
| New app version / config | New launch template version → `aws autoscaling start-instance-refresh` with preferences (min healthy, checkpoints, auto rollback). Nonprod first. |
| Patch OS | Rebuild golden AMI (EC2 Image Builder) and roll via instance refresh. For long-lived instances: SSM Patch Manager with patch baselines and maintenance windows (scan first: `Operation=Scan`). |
| Scale | Change min/max/desired in IaC. Emergency `set-desired-capacity` is a recorded incident action. |
| Run a command | `aws ssm send-command` with a document (`AWS-RunShellScript`) targeted by **instance id or tag + `--max-concurrency`/`--max-errors`**; output to S3/CloudWatch. Show the exact command and targets first. |
| Interactive access | `aws ssm start-session --target ID` (logged to S3/CloudWatch per Session Manager preferences). Only when needed; never in prod without approval. |
| Resize instance | Requires stop/start (downtime unless behind ASG). Prefer launch template change + refresh. |
| Terminate | ASG-managed: let ASG replace (`terminate-instance-in-auto-scaling-group --should-decrement-desired-capacity false`). Standalone: confirm backups/AMI, termination protection status, approval naming the id. |

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| Instance unhealthy in target group | Health check path/port/codes, SG from ALB, app logs via CloudWatch agent, `get-console-output` |
| SSM shows `ConnectionLost` | Instance role has `AmazonSSMManagedInstanceCore`, endpoints (`ssm`, `ssmmessages`, `ec2messages`) or NAT, agent running, time sync |
| ASG launch failures | `describe-scaling-activities` (capacity, quota, invalid AMI, KMS key policy for EBS, subnet IP exhaustion) |
| Instance reboot loop | Console output, status checks (system vs instance), recent user-data changes |
| High CPU / credits | T-family CPU credits (`CPUCreditBalance`), right-size via Compute Optimizer |
| Disk full | CloudWatch agent `disk_used_percent`; extend EBS online (gp3 `modify-volume`, then grow FS) as an approved change |

## 6. Hygiene audits

- IMDSv1 allowed, public IPs, unencrypted volumes, unattached EBS volumes and old snapshots, instances without SSM, instances not in ASG in prod, outdated AMIs (> 30-90 days), Inspector findings.

## Never

- Open SSH/RDP to the internet or add key pairs to work around SSM issues.
- Put secrets in user data, AMIs, or instance tags.
- Make AMIs or snapshots public (guard-blocked); share only with specific accounts/org.
- `send-command` to all instances (`--targets Key=InstanceIds,Values=*`) or run unreviewed scripts fleet-wide.
