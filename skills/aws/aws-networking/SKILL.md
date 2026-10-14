---
name: aws-networking
description: AWS networking design and operations - VPC/subnet/CIDR planning, security groups and NACLs, NAT and egress, VPC endpoints/PrivateLink, Transit Gateway, VPN/Direct Connect, Route 53 (public/private/Resolver), load balancers, CloudFront/WAF, flow logs and Reachability Analyzer troubleshooting. Use for VPC design, connectivity problems, security group changes or DNS issues.
---

# AWS Networking

Load `cloud-guardrails`. Network changes have large blast radius (one route or SG rule can cut off production). Prefer IaC; troubleshoot read-only first.

## 1. Design defaults

- **CIDR plan** from an IPAM (AWS VPC IPAM): non-overlapping /16-/20 per VPC across accounts, regions and on-prem. Reserve space for growth and secondary CIDRs (EKS pods).
- **Subnets per AZ** (3 AZs in prod): `public` (load balancers, NAT only), `private-app`, `private-data` (no route to NAT if not needed), optional `tgw` attachment subnets (/28).
- **No public IPs** on instances; public entry only through ALB/NLB/CloudFront/API Gateway. Inbound admin via **SSM Session Manager** (no port 22/3389).
- **Egress**: centralised egress VPC (TGW + NAT + AWS Network Firewall with domain allow-lists) for regulated workloads; per-VPC NAT per AZ otherwise. Note: all public IPv4 addresses are billed.
- **VPC endpoints**: S3 + DynamoDB gateway endpoints (free) everywhere; interface endpoints for `ssm`, `ssmmessages`, `ec2messages`, `ecr.api`, `ecr.dkr`, `logs`, `sts`, `kms`, `secretsmanager` in private workloads. Attach **endpoint policies** restricting to org principals/resources.
- **Flow logs** on every VPC (to S3 with Parquet or CloudWatch), include `pkt-srcaddr`/`pkt-dstaddr` fields for NAT debugging.
- **DNS**: Route 53 private hosted zones shared via RAM / profiles; Resolver endpoints for hybrid; Route 53 Resolver DNS Firewall for egress DNS filtering; DNSSEC on public zones.

## 2. Security groups (rules of thumb)

- Reference **security groups, not CIDRs**, between tiers (`alb-sg` → `app-sg` → `db-sg`).
- No `0.0.0.0/0` ingress except 80/443 on internet-facing LBs. Admin ports from the internet are guard-blocked.
- Egress: restrict for data tiers; default allow-all egress is common for app tiers but document it.
- One purpose per SG; descriptive names and rule descriptions.
- NACLs: keep default allow unless a compliance requirement needs subnet-level deny; they are stateless (return traffic on ephemeral ports 1024-65535).

Terraform pattern (separate rule resources, no inline):

```hcl
resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "ALB to app"
}
```

## 3. Read-only discovery

```bash
aws ec2 describe-vpcs --query "Vpcs[].{id:VpcId,cidr:CidrBlock,name:Tags[?Key=='Name']|[0].Value}" --output table
aws ec2 describe-subnets --filters Name=vpc-id,Values=VPC --query "Subnets[].{id:SubnetId,az:AvailabilityZone,cidr:CidrBlock,free:AvailableIpAddressCount,public:MapPublicIpOnLaunch}" --output table
aws ec2 describe-route-tables --filters Name=vpc-id,Values=VPC --query "RouteTables[].{id:RouteTableId,routes:Routes[].[DestinationCidrBlock,GatewayId,NatGatewayId,TransitGatewayId,VpcEndpointId]}"
aws ec2 describe-security-groups --group-ids SG --query "SecurityGroups[].IpPermissions"
aws ec2 describe-security-groups --filters Name=ip-permission.cidr,Values=0.0.0.0/0 --query "SecurityGroups[].{id:GroupId,name:GroupName}"
aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=VPC
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=VPC --query "VpcEndpoints[].{svc:ServiceName,type:VpcEndpointType,state:State}"
aws ec2 describe-transit-gateway-route-tables ; aws ec2 search-transit-gateway-routes --transit-gateway-route-table-id TGWRT --filters Name=state,Values=active
aws elbv2 describe-target-health --target-group-arn TG
```

## 4. Troubleshooting connectivity (in this order)

1. **DNS**: does the name resolve to the expected IP from the source? (`dig`, Resolver query logs, private zone association, endpoint private DNS enabled?)
2. **Route**: source subnet route table has a route to the destination (local / TGW / peering / NAT / IGW / endpoint)? Return path symmetric?
3. **Security groups**: destination SG allows source SG/CIDR on the port; source SG egress allows it.
4. **NACLs**: both directions, including ephemeral ports.
5. **Endpoint / resource policies**: VPC endpoint policy, bucket policy with `aws:SourceVpce`.
6. **Target health**: LB target group health check path/port/codes.
7. **Prove it**: VPC Reachability Analyzer (`aws ec2 create-network-insights-path` + `start-network-insights-analysis`) creates a small analysis resource: low risk, but still ask; then read `describe-network-insights-analyses` for the blocking component. Flow logs: look for `REJECT` with the 5-tuple.

## 5. Common changes and their safety notes

| Change | Notes |
| --- | --- |
| Add SG rule | Additive and low risk; still a change. Use SG references. Verify with a connection test. |
| Remove SG rule / change SG on ENI | Can drop live connections. Confirm no traffic via flow logs (last 14-30 days). |
| Route table change | High blast radius; prefer adding more-specific routes over replacing; have rollback route ready. |
| NAT gateway replacement | Changes egress IP; partners with IP allow-lists will break. |
| VPC peering / TGW attachment | Check CIDR overlap and route propagation; restrict with SGs, not just routes. |
| Endpoint private DNS enable | Changes resolution for the whole VPC for that service. |
| Load balancer listener/cert change | Use `ELBSecurityPolicy-TLS13-1-2-2021-06` (or newer); confirm cert covers all hostnames. |
| Route 53 record change | Lower TTL ahead of time; weighted/failover records for cutovers; never delete hosted zones (guard-blocked). |
| CloudFront / WAF | WAF changes in `COUNT` mode first; managed rule groups (Core, KnownBadInputs, IP reputation, Bot Control) with versions pinned. |

## 6. Hybrid

- Site-to-site VPN: two tunnels, BGP, monitor `TunnelState`; IKEv2, AES-256-GCM.
- Direct Connect: redundant connections in separate locations, MACsec where required, BGP communities for route preference.
- Advertise only needed prefixes; filter received routes.

## Never

- `0.0.0.0/0` to admin or database ports; public IPs on databases; disabling flow logs (guard-blocked).
- Delete route tables, IGWs, NAT gateways, TGW attachments or hosted zones in shared/prod networks from an agent.
- Change network ACLs to "allow all" to debug; use Reachability Analyzer and flow logs instead.
