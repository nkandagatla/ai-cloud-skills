---
name: aws-cost-optimization
description: Analyse and reduce AWS spend - Cost Explorer and CUR/Data Exports queries, top cost drivers, rightsizing with Compute Optimizer, Savings Plans/RI coverage analysis, idle and orphaned resources, storage and data-transfer savings, Graviton/Spot, budgets and anomaly detection. Use for cost reviews, unexpected bills, or optimisation plans on AWS.
---

# AWS Cost Optimization

Load `cloud-guardrails` and `finops-preflight`. Analysis is read-only. Every saving that changes resources goes through `cloud-change-plan`; **commitment purchases are human decisions** (the agent models them, never buys).

## 1. Where is the money going? (read-only)

```bash
# Last full month by service
aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE --query "ResultsByTime[0].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]" --output text | sort -t$'\t' -k2 -nr | head -15

# Daily trend for one service, by usage type (finds what exactly grew)
aws ce get-cost-and-usage --time-period Start=2026-09-15,End=2026-10-09 --granularity DAILY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}' --group-by Type=DIMENSION,Key=USAGE_TYPE

# By cost allocation tag
aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=app

# Anomalies
aws ce get-anomalies --date-interval StartDate=2026-09-01 --max-results 20
```

Cost Explorer API calls cost $0.01 each: batch your questions. For deep analysis use **CUR 2.0 / Data Exports** in Athena:

```sql
SELECT line_item_product_code, line_item_usage_type, SUM(line_item_unblended_cost) AS cost
FROM cur2 WHERE billing_period = '2026-09'
GROUP BY 1,2 ORDER BY cost DESC LIMIT 25;
```

## 2. Optimisation checklist (by typical size of win)

**Compute**
- Rightsize: `aws compute-optimizer get-ec2-instance-recommendations` / `get-ecs-service-recommendations` / `get-lambda-function-recommendations` / `get-auto-scaling-group-recommendations`.
- Graviton (`m7g`, `c7g`, `r7g`, Lambda `arm64`, Fargate ARM64): ~20% price-performance gain where compatible.
- Spot for stateless/batch/CI/nonprod (Karpenter, ASG mixed instances, Fargate Spot).
- Schedules: stop nonprod outside working hours (Instance Scheduler, ASG scheduled actions, RDS stop up to 7 days).
- Old generation instance families → current.

**Commitments (model only)**
```bash
aws ce get-savings-plans-purchase-recommendation --savings-plans-type COMPUTE_SP --term-in-years ONE_YEAR --payment-option NO_UPFRONT --lookback-period-in-days THIRTY_DAYS
aws ce get-savings-plans-coverage --time-period Start=2026-09-01,End=2026-10-01
aws ce get-reservation-purchase-recommendation --service "Amazon Relational Database Service" --lookback-period-in-days SIXTY_DAYS
```
Present coverage, utilisation, break-even and risk; recommend conservative coverage of the steady baseline.

**Storage**
- EBS gp2 → gp3 (cheaper, configurable IOPS); delete unattached volumes (after snapshot + approval); snapshot lifecycle (Data Lifecycle Manager).
- S3: Intelligent-Tiering for unknown patterns, lifecycle to IA/Glacier, expire noncurrent versions, abort incomplete multipart uploads, Storage Lens to find big/cold buckets.
- Old AMIs and their snapshots.

**Network (often hidden)**
- NAT Gateway processing: add S3/DynamoDB gateway endpoints (free) and interface endpoints for heavy AWS API traffic; check `NatGateway-Bytes` usage type.
- Cross-AZ traffic: keep chatty services zone-aware; topology-aware routing in EKS.
- Public IPv4 charges: release unused Elastic IPs, remove public IPs from instances.
- CloudFront in front of S3/ALB to cut egress.

**Databases**
- Aurora I/O-Optimized vs Standard (compare I/O share of cost), Aurora Serverless v2 for spiky dev, rightsize RDS, Graviton DB classes, delete idle dev DBs (after snapshot), DynamoDB on-demand vs provisioned + auto scaling, Standard-IA table class.

**Observability**
- CloudWatch Logs ingestion and retention (see `aws-observability`), high-cardinality custom metrics, unused dashboards/alarms are cheap but log ingestion is not.

**Orphans (read-only finders)**
```bash
aws ec2 describe-volumes --filters Name=status,Values=available --query "Volumes[].{id:VolumeId,gb:Size,created:CreateTime}"
aws ec2 describe-addresses --query "Addresses[?AssociationId==null].{ip:PublicIp,alloc:AllocationId}"
aws elbv2 describe-load-balancers --query "LoadBalancers[].LoadBalancerArn"   # then check target health / RequestCount = 0 over 14d
aws ec2 describe-snapshots --owner-ids self --query "Snapshots[?StartTime<='2025-10-01'].{id:SnapshotId,gb:VolumeSize}"
aws rds describe-db-instances --query "DBInstances[].DBInstanceIdentifier"   # check DatabaseConnections = 0 over 14d
```

## 3. Output

```
Period: Sep 2026  Total: $48,210 (+12% MoM)  Top drivers: EC2 38%, RDS 21%, NAT/data transfer 9%, CloudWatch 6%
| # | Opportunity | Est. saving/mo | Effort | Risk | Action (skill) |
| 1 | gp2→gp3 on 214 volumes | $1,900 | S | Low | IaC change (aws-ec2-autoscaling) |
| 2 | S3 gateway endpoint in 3 VPCs (NAT bytes 41 TB) | $1,850 | S | Low | aws-networking |
| 3 | Compute SP 1yr no-upfront for $9/h baseline | $3,100 | — | Commitment | Human decision |
```

## Never

- Purchase Savings Plans/RIs, change billing/payment settings, or modify budgets' actions.
- Delete "idle" resources without owner confirmation, a backup/snapshot, and approval naming each resource id.
- Turn off logging, backups, Multi-AZ or security services to save money without the owner's and security's explicit decision.
