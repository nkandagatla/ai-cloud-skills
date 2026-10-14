---
name: gcp-cloud-run-functions
description: Deploy and operate Cloud Run services/jobs and Cloud Run functions securely - dedicated service accounts, ingress settings and IAM invoker, IAP/load balancer fronting, Secret Manager integration, Direct VPC egress, revisions and traffic splitting, concurrency/min instances, Eventarc/Pub/Sub triggers, Binary Authorization, and troubleshooting. Use for serverless container or function deployments, 403/5xx issues, or cold starts on GCP.
---

# Cloud Run and Cloud Run functions

Load `cloud-guardrails` and `container-supply-chain`. Deploy via pipeline (Cloud Build / Cloud Deploy / GitHub Actions with WIF). Public unauthenticated access is guard-blocked; it must be an explicit, reviewed IaC decision.

## 1. Service baseline

```hcl
resource "google_cloud_run_v2_service" "orders" {
  name     = "orders-api"
  location = var.region
  project  = var.project_id
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"   # or INTERNAL_ONLY
  deletion_protection = true
  binary_authorization { use_default = true }
  template {
    service_account = google_service_account.orders_run.email   # never the default compute SA
    max_instance_request_concurrency = 80
    timeout = "30s"
    scaling { min_instance_count = 1, max_instance_count = 50 }   # max = cost guard
    vpc_access {
      network_interfaces { network = var.network, subnetwork = var.subnet }   # Direct VPC egress
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = "us-central1-docker.pkg.dev/acme-artifacts/apps/orders-api@sha256:${var.digest}"
      resources { limits = { cpu = "1", memory = "512Mi" }, cpu_idle = true, startup_cpu_boost = true }
      env {
        name = "DB_PASSWORD"
        value_source { secret_key_ref { secret = google_secret_manager_secret.db.secret_id, version = "latest" } }
      }
      startup_probe  { http_get { path = "/healthz" } }
      liveness_probe { http_get { path = "/livez" } }
    }
  }
  labels = local.labels
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.orders.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.frontend.email}"   # specific callers only
}
```

Public apps: external Application Load Balancer + **Cloud Armor** + optionally **IAP** in front, `ingress = INTERNAL_LOAD_BALANCER`; or Cloud Run's built-in IAP integration. Org policy `run.allowedIngress` enforces this.

Pin secret versions (`version = "3"`) for reproducibility, or use `latest` with a rollout process; mounting secrets as volumes re-reads on access.

## 2. Functions specifics

Cloud Run functions (2nd gen) are Cloud Run services: same SA / ingress / IAM / VPC rules. Event triggers via Eventarc (trigger SA needs `roles/run.invoker` on the function and `roles/eventarc.eventReceiver`). Make handlers **idempotent** (events are at-least-once); configure retries + dead-letter topics for Pub/Sub.

## 3. Jobs

Cloud Run jobs for batch: task count/parallelism, `max_retries`, task timeout; dedicated SA; executions logged. Triggering a job (`gcloud run jobs execute`) runs real work: it's a change.

## 4. Revisions and traffic

```bash
gcloud run services describe orders-api --region=R --project=P --format="yaml(status.traffic,status.latestReadyRevisionName,spec.template.spec.serviceAccountName)"
gcloud run revisions list --service=orders-api --region=R --project=P --format="table(metadata.name,status.conditions[0].status,metadata.creationTimestamp)"
# canary (change; pipeline in prod)
gcloud run deploy orders-api --image=IMAGE@sha256:D --no-traffic --tag=canary --region=R --project=P
gcloud run services update-traffic orders-api --to-tags=canary=10 --region=R --project=P
# rollback
gcloud run services update-traffic orders-api --to-revisions=orders-api-00041-abc=100 --region=R --project=P
```

## 5. Read-only troubleshooting

```bash
gcloud run services list --project=P --format="table(metadata.name,region,status.url,metadata.annotations.'run.googleapis.com/ingress')"
gcloud run services get-iam-policy orders-api --region=R --project=P      # check for allUsers
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="orders-api" AND severity>=ERROR' --freshness=1h --limit=50 --project=P --format="table(timestamp,severity,textPayload)"
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.status>=500' --freshness=1h --limit=20 --project=P --format="table(timestamp,httpRequest.status,httpRequest.requestUrl,httpRequest.latency)"
```

| Symptom | Check |
| --- | --- |
| 403 Forbidden | Caller lacks `roles/run.invoker`, missing/incorrect ID token audience, ingress setting blocks the path (e.g. direct URL with internal ingress) |
| 404 | Wrong region/URL, tag URL, ingress via LB path mismatch |
| 500/503 at start | Container not listening on `$PORT`, startup probe failing, secret access denied (SA lacks `secretmanager.secretAccessor`), memory limit |
| Cold starts | min instances (cost), startup CPU boost, smaller image, lazy init |
| Can't reach private resources | Direct VPC egress / connector, egress setting, firewall rules, DNS |
| Throttling / 429 | max instances reached, concurrency too low, quotas |

## Never

- `--allow-unauthenticated` / `allUsers` invoker (guard-blocked) unless an approved public design via IaC.
- Default compute SA, secrets in plain env vars, mutable image tags in prod.
- `--ingress=all` on internal services to debug; use the LB/internal path.
- Delete services or jobs in prod from the agent.
