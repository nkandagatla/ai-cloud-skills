---
name: gcp-secret-manager-kms
description: Google Cloud Secret Manager and Cloud KMS - secret creation and per-secret IAM, replication and CMEK, versions, rotation schedules with Pub/Sub, regional secrets, KMS key rings/keys/rotation, protection levels (software/HSM/external), CMEK for services, key IAM separation of duties, Autokey, and troubleshooting. Use when creating or reviewing secrets, keys, CMEK, rotation, or KMS/secret access errors on GCP.
---

# GCP Secret Manager and Cloud KMS

Load `cloud-guardrails` and `secrets-and-identity`. Agents manage containers, IAM and rotation plumbing. Agents never access secret payloads (`versions access`), decrypt, or destroy/disable key versions (guard-blocked).

## 1. Secret Manager

```hcl
resource "google_secret_manager_secret" "db" {
  secret_id = "orders-db-password"
  project   = var.project_id
  replication {
    user_managed {
      replicas {
        location = "us-central1"
        customer_managed_encryption { kms_key_name = var.kms_key_usc1 }
      }
      replicas { location = "us-east1"  customer_managed_encryption { kms_key_name = var.kms_key_use1 } }
    }
  }
  rotation {
    rotation_period    = "2592000s"            # 30 days
    next_rotation_time = "2026-11-01T00:00:00Z"
  }
  topics { name = google_pubsub_topic.secret_rotation.id }   # Secret Manager publishes SECRET_ROTATE events
  version_destroy_ttl = "604800s"              # delayed destruction (7 days) for safety
  labels = local.labels
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  secret_id = google_secret_manager_secret.db.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.orders_run.email}"
}
```

- The **value** is not in Terraform: a rotation Cloud Run job (triggered by the Pub/Sub rotation topic) generates and adds versions, or a human adds the first version. If Terraform must create it, use ephemeral resources / write-only arguments where the provider supports them; otherwise the value lands in state.
- `secretAccessor` per secret, not per project. Admin (`roles/secretmanager.admin`) only for the platform team.
- Regional secrets (`google_secret_manager_regional_secret`) when data residency requires a single region.
- Consumers: Cloud Run `value_source.secret_key_ref` / volume mounts, GKE Secret Manager add-on or CSI, SDK with ADC. Pin versions or use aliases for controlled rollouts.
- Data Access audit logs for `secretmanager.googleapis.com` show who accessed which secret.

## 2. Cloud KMS

- Key ring per environment and region (`kr-orders-prod-usc1`); keys per data domain (`k-orders-data`); key rings and keys **cannot be deleted** (only versions destroyed), so name them carefully.
- **Rotation period** (e.g. 90 days) for symmetric encryption keys; asymmetric keys rotate manually with planned version switch.
- **Protection level**: `SOFTWARE`, `HSM` (Cloud HSM, FIPS 140-2 L3), `EXTERNAL` / `EXTERNAL_VPC` (Cloud EKM) for regulated key custody.
- **Separation of duties**: key admins (`roles/cloudkms.admin`) ≠ key users (`roles/cloudkms.cryptoKeyEncrypterDecrypter` granted to **service agents** of the consuming services, per key). Put KMS in a dedicated security project.
- **Cloud KMS Autokey** can provision CMEK keys on demand with consistent policies.
- `destroy_scheduled_duration` (default 30 days) gives a recovery window for destroyed versions.
- Org policies `gcp.restrictNonCmekServices` and `gcp.restrictCmekCryptoKeyProjects` to enforce CMEK and approved key projects.

```hcl
resource "google_kms_crypto_key" "orders" {
  name            = "k-orders-data"
  key_ring        = google_kms_key_ring.prod_usc1.id
  rotation_period = "7776000s"   # 90 days
  purpose         = "ENCRYPT_DECRYPT"
  version_template { algorithm = "GOOGLE_SYMMETRIC_ENCRYPTION", protection_level = "HSM" }
  lifecycle { prevent_destroy = true }
}
resource "google_kms_crypto_key_iam_member" "gcs_agent" {
  crypto_key_id = google_kms_crypto_key.orders.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}
```

## 3. Read-only inspection (never payloads)

```bash
gcloud secrets list --project=P --format="table(name,replication.userManaged.replicas[].location.list(),rotation.nextRotationTime,createTime)"
gcloud secrets describe orders-db-password --project=P
gcloud secrets versions list orders-db-password --project=P --format="table(name,state,createTime)"
gcloud secrets get-iam-policy orders-db-password --project=P
gcloud kms keyrings list --location=us-central1 --project=SEC
gcloud kms keys list --keyring=kr-orders-prod-usc1 --location=us-central1 --project=SEC --format="table(name,purpose,rotationPeriod,nextRotationTime,primary.state,versionTemplate.protectionLevel)"
gcloud kms keys versions list --key=k-orders-data --keyring=kr-orders-prod-usc1 --location=us-central1 --project=SEC
gcloud kms keys get-iam-policy k-orders-data --keyring=kr-orders-prod-usc1 --location=us-central1 --project=SEC
```

## 4. Troubleshooting

| Error | Check |
| --- | --- |
| `PERMISSION_DENIED secretmanager.versions.access` | Accessor role on that secret for the workload's SA (not your user), correct project, VPC-SC |
| `NOT_FOUND` version | Version destroyed/disabled, alias/`latest` points to disabled version |
| CMEK service failing (`The key ... is disabled`) | Key version disabled/destroyed or service agent lost encrypter/decrypter: **critical**, page a human; restore the version within the scheduled-destroy window |
| `FAILED_PRECONDITION` creating resource | Org policy requires CMEK or restricts key projects |
| Rotation not happening | Rotation only **publishes notifications**; your Pub/Sub-triggered job must add versions; check its logs |

## Never

- `gcloud secrets versions access`, `kms decrypt`, `print-access-token` (guard-blocked).
- Destroy/disable key versions or set KMS IAM policy wholesale (guard-blocked).
- Grant `secretAccessor` or `cryptoKeyEncrypterDecrypter` at project/org level, or to humans permanently.
- Store secret values in Terraform variables, tfvars, CI variables or code.
