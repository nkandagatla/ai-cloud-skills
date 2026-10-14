---
name: gcp-networking
description: Google Cloud networking design and operations - custom-mode VPCs, Shared VPC, subnets and secondary ranges, hierarchical and network firewall policies, Cloud NAT, Private Google Access and Private Service Connect, Cloud DNS (private zones, forwarding), Cloud Load Balancing and Cloud Armor, IAP TCP forwarding, VPN/Interconnect, NCC, flow logs and Connectivity Tests. Use for VPC design, firewall changes, connectivity or DNS problems on GCP.
---

# Google Cloud Networking

Load `cloud-guardrails`. VPCs are global; one firewall or route change can affect every region. Shared VPC host projects belong to the network team.

## 1. Design defaults

- **Custom-mode VPCs** only (delete or never create the `default` network; org policy `compute.skipDefaultNetworkCreation`).
- **Shared VPC**: host project per environment (prod / nonprod), service projects attach; subnet-level IAM (`roles/compute.networkUser` on specific subnets).
- Subnets per region and tier with **secondary ranges** for GKE pods/services; non-overlapping with other clouds/on-prem (IPAM).
- **Private Google Access** on all subnets; `restricted.googleapis.com` with VPC-SC.
- **No external IPs** on VMs (org policy); egress via **Cloud NAT** (per region, logging on errors), optionally Secure Web Proxy / NGFW for egress filtering.
- Admin access through **IAP TCP forwarding** (`35.235.240.0/20`) + OS Login; no 22/3389 from the internet.
- **Firewall policies** (hierarchical at org/folder for global denies and allows; network firewall policies per VPC) over legacy VPC firewall rules; use **secure tags** for targeting (IAM-controlled) rather than network tags.
- **VPC Flow Logs** on subnets (sampling per cost), **Firewall Rules Logging** on deny rules and sensitive allows.
- Private services: Private Service Connect endpoints for Google APIs and producer services; private services access (PSA) for Cloud SQL/Memorystore where PSC is not used.
- Cloud DNS private zones; forwarding zones / DNS server policies for hybrid; DNSSEC on public zones.

## 2. Firewall rules of thumb

```hcl
resource "google_compute_network_firewall_policy_rule" "allow_iap_ssh" {
  firewall_policy = google_compute_network_firewall_policy.vpc.name
  priority        = 1000
  direction       = "INGRESS"
  action          = "allow"
  description     = "IAP TCP forwarding for SSH to tagged admin hosts"
  match {
    src_ip_ranges = ["35.235.240.0/20"]
    layer4_configs { ip_protocol = "tcp", ports = ["22"] }
  }
  target_secure_tags { name = google_tags_tag_value.ssh_via_iap.id }
  enable_logging = true
}
```

- Never `0.0.0.0/0` to 22/3389/database ports (guard-blocked); 80/443 public only on load balancers (which use Google front ends, so backends allow `130.211.0.0/22` and `35.191.0.0/16` for health checks / proxies).
- Explicit low-priority deny-all ingress with logging documents intent; egress deny for data tiers where feasible.

## 3. Read-only discovery

```bash
gcloud compute networks list --project=HOST --format="table(name,subnet_mode,routing_config.routing_mode)"
gcloud compute networks subnets list --project=HOST --format="table(name,region,ipCidrRange,privateIpGoogleAccess,secondaryIpRanges.list():label=SECONDARY,logConfig.enable:label=FLOWLOGS)"
gcloud compute firewall-rules list --project=HOST --format="table(name,network,direction,priority,sourceRanges.list(),allowed[].map().firewall_rule().list(),targetTags.list(),disabled)"
gcloud compute firewall-rules list --project=HOST --filter="sourceRanges:0.0.0.0/0 AND direction=INGRESS" --format="table(name,allowed[].map().firewall_rule().list())"
gcloud compute network-firewall-policies list --project=HOST ; gcloud compute network-firewall-policies rules list --firewall-policy=POL --global-firewall-policy --project=HOST
gcloud compute firewall-policies list --organization=ORG      # hierarchical
gcloud compute routers list --project=HOST ; gcloud compute routers get-nat-mapping-info ROUTER --region=R --project=HOST
gcloud compute routes list --project=HOST --filter="network~VPC" --format="table(name,destRange,nextHopGateway,nextHopIp,priority)"
gcloud dns managed-zones list --project=HOST --format="table(name,dnsName,visibility)"
gcloud compute shared-vpc associated-projects list HOST
```

## 4. Troubleshooting

1. **Connectivity Tests** (Network Intelligence Center): `gcloud network-management connectivity-tests create t1 --source-instance=... --destination-ip-address=... --protocol=TCP --destination-port=5432 --project=P` creates a test resource (low risk; ask), then `describe` shows the hop where traffic drops (firewall, route, NAT, PSC).
2. **Firewall Insights**: shadowed/unused rules, deny hit counts.
3. **DNS**: does the name resolve to the PSC/private IP from the VPC? Private zone bound to the right network? Response policies?
4. **Routes**: custom static/dynamic routes, peering route export/import, Cloud Router BGP status (`gcloud compute routers get-status`).
5. **NAT**: port exhaustion (NAT logs `OUT_OF_RESOURCES`, `allocated_ports` metrics) → dynamic port allocation / more IPs.
6. **Load balancer**: backend health (`gcloud compute backend-services get-health`), health check firewall ranges, NEG configuration, Cloud Armor denies (LB logs `enforcedSecurityPolicy`).
7. **VPC-SC**: if API calls fail with `VPC_SERVICE_CONTROLS`, it's the perimeter, not the network (`gcp-org-policy-security`).

## 5. Changes and safety notes

| Change | Notes |
| --- | --- |
| Add firewall rule | Low risk; use secure tags and specific ranges; enable logging |
| Delete/disable firewall rule | Check Firewall Insights hit counts (last 30 days) first |
| Route / peering / NCC changes | High blast radius, network team, rollback ready |
| Cloud NAT changes | Changes egress IPs (partner allow-lists); port allocation affects running connections |
| Cloud Armor policy | Preview mode for new rules; preconfigured WAF rules with sensitivity levels; adaptive protection; rate limiting |
| Subnet expansion | `expand-ip-range` is one-way (cannot shrink) |
| Private zone changes | Affect every workload resolving that name in the network |

## Never

- Open admin/database ports to the internet, assign external IPs to VMs, or create auto-mode/default networks.
- Disable subnet flow logs (guard-blocked) or delete Cloud Armor policies (guard-blocked).
- Modify Shared VPC host project networking from a service project's agent session.
