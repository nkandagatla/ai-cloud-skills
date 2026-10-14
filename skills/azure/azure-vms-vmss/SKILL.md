---
name: azure-vms-vmss
description: Operate Azure Virtual Machines and Virtual Machine Scale Sets securely - images (Compute Gallery, Image Builder), Trusted Launch, encryption at host/disk encryption sets, managed identity, Bastion/JIT access, Update Manager patching, Run Command, VMSS rolling upgrades and autoscale, Azure Monitor Agent, and troubleshooting boot/connectivity. Use for VM/VMSS builds, patching, scaling or VM issues on Azure.
---

# Azure VMs and VM Scale Sets

Load `cloud-guardrails`. Prefer **VMSS (Flexible orchestration) with images** over hand-maintained single VMs. Changes go into the image/model and roll out with upgrade policies.

## 1. Secure VM baseline

- **Trusted Launch** (Secure Boot + vTPM) or Confidential VM where required.
- **Encryption at host** enabled (covers temp disk and caches) and/or **Disk Encryption Sets** with CMK in Key Vault (Azure Disk Encryption is legacy for new deployments; check current guidance).
- **No public IP**; NSG on subnet; access via **Azure Bastion** or **Just-In-Time** (Defender for Servers).
- **Entra ID login** for VMs (`AADSSHLoginForLinux` / `AADLoginForWindows` extensions) with `Virtual Machine User Login` / `Administrator Login` roles; disable password auth on Linux; no shared local admin passwords (Windows LAPS if local admin needed).
- **Managed identity** with least-privilege data roles; no secrets in custom data / cloud-init (fetch from Key Vault at boot).
- **Azure Monitor Agent** + Data Collection Rules; Defender for Servers; Update Manager (periodic assessment on).
- Availability zones (zonal or VMSS across zones) for prod.
- Boot diagnostics with managed storage.

Bicep fragment:

```bicep
resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-07-01' = {
  name: 'vmss-orders-prod-eus'
  location: location
  zones: ['1', '2', '3']
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${uami.id}': {} } }
  sku: { name: 'Standard_D4as_v5', capacity: 3 }
  properties: {
    orchestrationMode: 'Flexible'
    platformFaultDomainCount: 1
    upgradePolicy: { mode: 'Rolling', rollingUpgradePolicy: { maxBatchInstancePercent: 20, maxUnhealthyInstancePercent: 20, pauseTimeBetweenBatches: 'PT2M', prioritizeUnhealthyInstances: true } }
    automaticRepairsPolicy: { enabled: true, gracePeriod: 'PT10M' }
    virtualMachineProfile: {
      securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }, encryptionAtHost: true }
      storageProfile: { imageReference: { id: galleryImageVersionId }, osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS', diskEncryptionSet: { id: desId } } } }
      osProfile: { computerNamePrefix: 'orders', adminUsername: 'azureops', linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [ { path: '/home/azureops/.ssh/authorized_keys', keyData: sshPublicKey } ] } } }
      networkProfile: { networkApiVersion: '2020-11-01', networkInterfaceConfigurations: [ { name: 'nic', properties: { primary: true, ipConfigurations: [ { name: 'ipc', properties: { subnet: { id: subnetId }, applicationGatewayBackendAddressPools: [ { id: appGwPoolId } ] } } ] } } ] }
      extensionProfile: { extensions: [ { name: 'AMA', properties: { publisher: 'Microsoft.Azure.Monitor', type: 'AzureMonitorLinuxAgent', typeHandlerVersion: '1.0', autoUpgradeMinorVersion: true, enableAutomaticUpgrade: true } } ] }
    }
  }
}
```

(The SSH public key is not a secret; private keys never appear anywhere in IaC.)

## 2. Read-only operations

```bash
az vm list -d --subscription S --query "[].{n:name,rg:resourceGroup,size:hardwareProfile.vmSize,state:powerState,publicIp:publicIps,zone:zones[0]}" -o table
az vm get-instance-view -g RG -n VM --query "{status:instanceView.statuses[].displayStatus,agent:instanceView.vmAgent.statuses[0].message}"
az vm boot-diagnostics get-boot-log -g RG -n VM | tail -50
az vmss list-instances -g RG -n VMSS --query "[].{id:instanceId,name:name,state:provisioningState,latest:latestModelApplied,zone:zones[0]}" -o table
az vmss get-instance-view -g RG -n VMSS --query "statuses"
az monitor autoscale show -g RG -n AUTOSCALE
az graph query -q "resources | where type =~ 'microsoft.compute/virtualmachines' | extend sec=properties.securityProfile | project name, resourceGroup, trusted=sec.securityType, encAtHost=sec.encryptionAtHost"
```

Patch status: Update Manager / `az graph query -q "patchassessmentresources | ..."`.

## 3. Changes

| Task | Approach |
| --- | --- |
| New app/OS version | New Compute Gallery image version (Azure Image Builder / Packer) → update VMSS model → rolling upgrade (`az vmss rolling-upgrade start`) with health probe / Application Health extension |
| Patching | Azure Update Manager maintenance configurations (schedules, pre/post scripts), assessment first; for VMSS: automatic OS image upgrades with health signals |
| Run a command | `az vm run-command invoke` (or managed Run Command, logs to blob) runs as SYSTEM/root: show the script and the exact VM targets; never fleet-wide without approval and batching |
| Resize | Requires deallocate/restart for many size changes; VMSS: update model + rolling upgrade |
| Scale | Autoscale profiles in IaC; manual `az vmss scale` is an incident action |
| Stop to save cost | `az vm deallocate` (stop without deallocate still bills compute) |
| Delete | Deleting a VM may keep or delete disks/NICs (`deleteOption`); confirm disks/backups; approval naming each resource |

## 4. Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot connect | Bastion subnet/NSG, JIT request approved, Entra login role, VM agent `Ready`, effective NSG (`az network nic list-effective-nsg`) |
| VM not booting | Boot diagnostics serial log/screenshot; serial console (requires boot diagnostics + permissions; interactive, approval needed) |
| Extension failures | `az vm extension list -g RG --vm-name VM -o table`, extension logs on VM |
| VMSS instances unhealthy | Health probe path/port, Application Health extension, automatic repairs events |
| Allocation failure | Size not available in zone/region; capacity reservation; try other zone/size |
| Disk throttling | Disk IOPS/throughput metrics vs SKU limits; Premium SSD v2 for tunable performance |

## Never

- Attach public IPs or open 22/3389 to the internet (guard-blocked) as a workaround.
- Put passwords in templates, custom data or Run Command scripts; enable password auth on Linux.
- Run unreviewed Run Command scripts or run them on all VMs at once.
- Delete VMs/disks in prod, or disable Trusted Launch/encryption to make an image work.
