---
name: gcp-compute-engine
description: Operate Google Compute Engine and managed instance groups securely - instance templates, custom images and image families, Shielded VM, OS Login and IAP access, dedicated service accounts with minimal scopes, CMEK disks, VM Manager (OS patch, inventory), MIG autoscaling/autohealing/rolling updates, snapshots schedules, and troubleshooting. Use for GCE/MIG builds, patching, scaling or VM issues on GCP.
---

# Google Compute Engine and MIGs

Load `cloud-guardrails`. Prefer **regional MIGs from instance templates** with immutable images; roll out changes with rolling updates, not by SSH.

## 1. Secure instance template baseline

```hcl
resource "google_compute_region_instance_template" "app" {
  name_prefix  = "orders-"
  region       = var.region
  machine_type = "n2d-standard-4"          # or t2a/c4a (Arm) where compatible
  disk {
    source_image      = "projects/acme-images/global/images/family/orders-base"   # hardened image family
    disk_type         = "pd-balanced"
    disk_size_gb      = 30
    boot              = true
    auto_delete       = true
    disk_encryption_key { kms_key_self_link = var.cmek_key_id }   # if CMEK required
  }
  network_interface {
    subnetwork = var.subnet_self_link     # no access_config block = no external IP
  }
  service_account {
    email  = google_service_account.orders_vm.email
    scopes = ["cloud-platform"]           # IAM roles on the SA are the real control; never the default compute SA
  }
  shielded_instance_config { enable_secure_boot = true, enable_vtpm = true, enable_integrity_monitoring = true }
  metadata = {
    enable-oslogin          = "TRUE"
    enable-oslogin-2fa      = "TRUE"      # for human access, if required
    block-project-ssh-keys  = "TRUE"
    serial-port-enable      = "FALSE"
  }
  labels = local.labels
  lifecycle { create_before_destroy = true }
}
```

- No secrets in metadata/startup scripts (metadata is readable by anyone with `compute.instances.get`); fetch from Secret Manager with the SA at boot.
- Confidential VM for sensitive workloads; sole-tenant nodes only when licensing requires.
- Ops Agent installed via the image or VM Manager policy.

## 2. MIG settings

- **Regional** MIG (multiple zones) for prod; target size ≥ 2-3.
- **Autohealing** health check (separate from LB health check, more lenient), `initial_delay_sec` realistic.
- **Autoscaling** on CPU / LB utilisation / custom metrics; min/max bounded; predictive autoscaling for cyclical load.
- **Update policy**: `PROACTIVE`, `max_surge` ≥ 1 per zone, `max_unavailable` 0 for prod, `minimal_action = REPLACE`; canary with a second version at `target_size` percent.
- Stateful MIGs only for stateful workloads (preserve disks/IPs).

## 3. Read-only operations

```bash
gcloud compute instances list --project=P --format="table(name,zone.basename(),machineType.basename(),status,networkInterfaces[0].networkIP,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)"
gcloud compute instances describe VM --zone=Z --project=P --format="yaml(serviceAccounts,shieldedInstanceConfig,metadata.items)"  # metadata may include startup scripts: review, don't paste secrets
gcloud compute instance-groups managed list --project=P
gcloud compute instance-groups managed describe MIG --region=R --project=P --format="yaml(status,updatePolicy,versions,autoHealingPolicies)"
gcloud compute instance-groups managed list-instances MIG --region=R --project=P --format="table(instance.basename(),status,currentAction,version.instanceTemplate.basename(),instanceHealth[0].detailedHealthState)"
gcloud compute instance-groups managed list-errors MIG --region=R --project=P --limit=20
gcloud compute instances get-serial-port-output VM --zone=Z --project=P | tail -50
gcloud compute os-config patch-jobs list --project=P --limit=10
gcloud compute os-config inventories list --location=Z --project=P --limit=5
```

## 4. Changes

| Task | Approach |
| --- | --- |
| New version | New instance template → `gcloud compute instance-groups managed rolling-action start-update MIG --version=template=NEW --region=R` (canary first with `--canary-version=template=NEW,target-size=10%`) via IaC / pipeline |
| Rollback | Rolling update back to the previous template |
| Patching | Rebuild image family (Packer / Cloud Build) and roll; for long-lived VMs: VM Manager **OS patch** deployments with zone-by-zone rollout and pre/post steps, `--dry-run` first |
| SSH access | `gcloud compute ssh VM --tunnel-through-iap --zone=Z` (OS Login identity); interactive access needs approval in nonprod and an incident in prod |
| Resize | Stop/start required for machine type change; MIG: new template + rolling replace |
| Snapshots | Snapshot schedules (resource policies) attached via IaC; manual snapshot before risky changes |
| Delete | MIG-managed instances get recreated; standalone: confirm snapshots/data, approval naming each instance |

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| Instance not booting / startup failure | Serial port output, startup script logs (`google_metadata_script_runner` in Cloud Logging), image family change |
| `gcloud compute ssh` fails | IAP firewall rule (35.235.240.0/20 on 22), `roles/iap.tunnelResourceAccessor`, OS Login roles (`roles/compute.osLogin`), guest agent running |
| MIG stuck / instances recreating | `list-errors`, autohealing health check too strict, quota, zone resource availability, template referencing missing image/key |
| Can't reach Google APIs | Private Google Access on subnet, DNS for `*.googleapis.com`, VPC-SC |
| Permission errors from VM | Attached SA's IAM roles (scopes are secondary), Workload uses ADC from metadata server |

## Never

- Attach external IPs, use the default compute SA, enable project-wide SSH keys or serial port access to work around access problems.
- Put secrets in metadata, startup scripts, images or labels.
- Make images public or share with `allAuthenticatedUsers` (guard-blocked).
- Delete disks or snapshots without verified backups and approval.
