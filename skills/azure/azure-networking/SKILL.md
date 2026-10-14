---
name: azure-networking
description: Azure networking design and operations - VNets/subnets/IP planning, NSGs and ASGs, hub-spoke and Virtual WAN, Azure Firewall, UDRs, Private Endpoints and Private DNS zones, service endpoints, NAT Gateway, Application Gateway/WAF, Front Door, Load Balancer, Bastion, VPN/ExpressRoute, flow logs and Network Watcher troubleshooting. Use for VNet design, connectivity or DNS problems, NSG changes, or private endpoint setup.
---

# Azure Networking

Load `cloud-guardrails`. Networking in Azure is often shared (hub VNet, firewall, DNS) across many teams; a change in the hub can take down every spoke. Hub/connectivity changes belong to the platform team.

## 1. Design defaults

- **Hub-spoke** (or Virtual WAN): hub holds Azure Firewall, VPN/ExpressRoute gateways, Bastion, DNS Private Resolver; spokes per app/environment peered to hub. Spoke-to-spoke via the firewall.
- **IP plan** from an IPAM (Azure Virtual Network Manager IPAM or external): non-overlapping across regions and on-prem.
- **Subnets** per tier; dedicated subnets for `AzureFirewallSubnet`, `GatewaySubnet`, `AzureBastionSubnet`, Application Gateway, private endpoints, delegated services (App Service VNet integration, Container Apps, PostgreSQL flexible).
- **Default outbound access is retired for new VNets**: give subnets explicit egress (NAT Gateway or firewall via UDR); private subnets (`defaultOutboundAccess: false`).
- **No public IPs on VMs**. Admin access via **Azure Bastion** or JIT; inbound apps via Application Gateway WAF / Front Door WAF.
- **PaaS privately**: Private Endpoints + Private DNS zones (`privatelink.blob.core.windows.net`, etc.) linked to the hub/DNS resolver; disable public network access on the PaaS resource. Use Azure Policy `DeployIfNotExists` to create DNS records automatically.
- **NSG flow logs → VNet flow logs** (NSG flow logs are being retired) + Traffic Analytics.
- **DDoS Network Protection** on hub/public-facing VNets for prod (cost: significant per month; decide per `finops-preflight`).

## 2. NSG rules of thumb

- Use **service tags** (`AzureLoadBalancer`, `VirtualNetwork`, `AzureFrontDoor.Backend`) and **ASGs** instead of IP lists.
- Explicit deny-all at the end of custom rules is redundant (default rules) but explicit `DenyAllInbound` at priority 4096 documents intent.
- Never allow `*`/`Internet` to 22/3389/5985/5986/1433/3306/5432 (guard-blocked).
- Rule descriptions and ticket references; priorities with gaps (100, 110, ...).

```hcl
resource "azurerm_network_security_rule" "app_from_appgw" {
  name                        = "allow-appgw-to-app-8080"
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_address_prefix       = var.appgw_subnet_prefix
  source_port_range           = "*"
  destination_application_security_group_ids = [azurerm_application_security_group.app.id]
  destination_port_range      = "8080"
  resource_group_name         = azurerm_resource_group.net.name
  network_security_group_name = azurerm_network_security_group.app.name
}
```

## 3. Read-only discovery

```bash
az network vnet list --subscription S --query "[].{n:name,rg:resourceGroup,space:addressSpace.addressPrefixes}" -o table
az network vnet subnet list -g RG --vnet-name V --query "[].{n:name,prefix:addressPrefix,nsg:networkSecurityGroup.id,rt:routeTable.id,pe:privateEndpointNetworkPolicies}" -o table
az network vnet peering list -g RG --vnet-name V --query "[].{n:name,state:peeringState,remote:remoteVirtualNetwork.id,gw:useRemoteGateways}" -o table
az network nsg rule list -g RG --nsg-name N --include-default -o table
az network route-table route list -g RG --route-table-name RT -o table
az network nic show-effective-route-table -g RG -n NIC -o table          # effective routes on a VM NIC
az network nic list-effective-nsg -g RG -n NIC                          # effective NSG rules
az network private-endpoint list -g RG --query "[].{n:name,target:privateLinkServiceConnections[0].privateLinkServiceId,state:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}" -o table
az network private-dns zone list -o table ; az network private-dns link vnet list -g RG -z privatelink.blob.core.windows.net -o table
az graph query -q "resources | where type =~ 'microsoft.network/networksecuritygroups' | mv-expand r=properties.securityRules | where r.properties.access=='Allow' and r.properties.direction=='Inbound' and (r.properties.sourceAddressPrefix in ('*','Internet','0.0.0.0/0')) | project nsg=name, rule=r.name, ports=r.properties.destinationPortRange"
```

## 4. Troubleshooting connectivity

1. **DNS**: from the source, does the PaaS FQDN resolve to the **private** IP? If public: private DNS zone missing, not linked to the VNet (or to the resolver's VNet), or the client uses a custom DNS server that does not forward to `168.63.129.16` / DNS Private Resolver.
2. **Effective routes** on the source NIC: UDR sending traffic to the firewall? Is the firewall allowing it (Azure Firewall logs / structured logs in Log Analytics)?
3. **Effective NSGs** on source and destination NICs/subnets.
4. **Network Watcher**: `az network watcher test-ip-flow` (NSG verdict), `az network watcher show-next-hop`, Connection Troubleshoot (`az network watcher test-connectivity`, needs the extension on the VM): these are diagnostic, low risk.
5. **PaaS firewall**: resource's own network rules (`publicNetworkAccess`, IP rules, trusted services exception).
6. **Asymmetric routing** through firewalls (common with peering + UDR + load balancers).
7. Flow logs / Traffic Analytics for denied flows.

## 5. Changes and safety notes

| Change | Notes |
| --- | --- |
| Add NSG rule | Low risk, still a change; prefer ASGs/service tags |
| UDR / route change in hub or spoke | High blast radius; plan rollback; check BGP propagation settings on route tables |
| Peering changes | Can drop all spoke connectivity; `allowForwardedTraffic`/`useRemoteGateways` settings matter |
| Private endpoint creation | Creates DNS records; disabling public access afterwards cuts off clients still using public endpoints: check access logs first |
| Firewall policy rule change | Use rule collection groups; IDPS in alert mode first; test in nonprod policy |
| Application Gateway WAF | Detection mode first, OWASP CRS / DRS version pinned, exclusions narrow |
| Front Door | Origin private link where possible; WAF policy with managed rule sets; lock origin to `X-Azure-FDID` header |
| ExpressRoute / VPN | Platform team only |

## Never

- Open admin/database ports to the internet, attach public IPs to VMs in Corp landing zones, or delete NSGs/route tables/peerings in shared networks.
- Disable flow logs or Network Watcher (guard-blocked where detectable).
- Set PaaS `publicNetworkAccess: Enabled` with default action Allow to "fix" connectivity (guard-blocked for Key Vault/storage): fix DNS/private endpoints instead.
