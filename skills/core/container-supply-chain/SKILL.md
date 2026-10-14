---
name: container-supply-chain
description: Secure container and artifact supply chain across ECR, ACR, Artifact Registry - minimal base images, Dockerfile hardening, vulnerability scanning, SBOMs, signing with cosign/Notation, provenance (SLSA), registry access control, and admission policies that only allow signed images. Use when writing Dockerfiles, building images in CI, or securing registries and clusters.
---

# Container Supply Chain

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

Only trusted, scanned, signed images built from reviewed code should reach a cluster or serverless runtime. Enforce it at admission, not by convention.

## 1. Dockerfile hardening

```dockerfile
# Pin base image by digest; minimal / distroless where possible
FROM node:22-bookworm-slim@sha256:<digest> AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12@sha256:<digest>
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "dist/server.js"]
```

Checklist: multi-stage; non-root `USER`; no secrets in `ARG`/`ENV`/layers (use BuildKit `--secret`); `.dockerignore` excludes `.git`, `.env`, `*.tfstate`, keys; no `curl | sh`; `HEALTHCHECK` or platform probes; read-only root filesystem compatible.

Lint: `hadolint Dockerfile`.

## 2. Build, scan, SBOM, sign (CI)

```bash
docker buildx build --provenance=mode=max --sbom=true -t $REG/app:$GIT_SHA --push .
trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed $REG/app:$GIT_SHA
syft $REG/app:$GIT_SHA -o spdx-json > sbom.spdx.json
cosign sign --yes $REG/app@$DIGEST                      # keyless (OIDC, Sigstore) or --key with KMS:
cosign sign --key awskms:///alias/cosign $REG/app@$DIGEST   # azurekms://, gcpkms:// also supported
cosign attest --yes --type spdxjson --predicate sbom.spdx.json $REG/app@$DIGEST
```

Sign the **digest**, not the tag. Use the GitHub Actions `attest-build-provenance` action or SLSA generators for provenance. Notation (Notary v2) with Azure Key Vault is the Microsoft-native alternative on ACR.

Native scanning: ECR enhanced scanning (Amazon Inspector), Defender for Containers (ACR), Artifact Analysis (Artifact Registry). Use them in addition to CI scans; they rescan for new CVEs.

## 3. Registry security

| | ECR | ACR | Artifact Registry |
| --- | --- | --- | --- |
| Immutable tags | `imageTagMutability = IMMUTABLE` | Lock tags (`az acr repository update --write-enabled false`) or use digests | Immutable tags setting |
| Auth | IAM (no static creds); pull via node/task roles | Entra ID + managed identity, `AcrPull` role; **admin user disabled**; no anonymous pull | IAM `roles/artifactregistry.reader` to node/runtime SA |
| Network | VPC endpoints (`ecr.api`, `ecr.dkr`, S3 gateway) | Private endpoint, `public_network_access_enabled = false` (Premium) | VPC-SC perimeter, Private Google Access |
| Encryption | KMS | CMK (Premium) | CMEK |
| Lifecycle | Lifecycle policies (untagged > 14d) | Retention policy for untagged; `az acr run` purge tasks | Cleanup policies |
| Cross-account | Repository policy with `aws:PrincipalOrgID` | Scope maps / tokens (avoid) or RBAC across tenants | IAM on repository |
| Upstream caching | Pull-through cache rules | Artifact cache rules | Remote repositories |

Pull public images through a **pull-through cache / remote repository** so builds do not depend on Docker Hub and you can scan/allow-list upstreams.

## 4. Admission: only signed, scanned images

Kyverno example (works on EKS, AKS, GKE):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: require-signed-images }
spec:
  validationFailureAction: Audit   # switch to Enforce after a clean audit period
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-signature
      match: { any: [ { resources: { kinds: [Pod] } } ] }
      verifyImages:
        - imageReferences: ["123456789012.dkr.ecr.us-east-1.amazonaws.com/*"]
          mutateDigest: true
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/acme/app/.github/workflows/release.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor: { url: https://rekor.sigstore.dev }
    - name: allowed-registries
      match: { any: [ { resources: { kinds: [Pod] } } ] }
      validate:
        message: "Images must come from the approved registry."
        pattern:
          spec:
            containers:
              - image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/*"
```

Cloud-native options: GKE **Binary Authorization** (attestors + policy), AKS **Image Integrity** (Ratify + Azure Policy, Notation), EKS with Kyverno / Gatekeeper + Ratify. Serverless: Cloud Run supports Binary Authorization; Lambda supports **code signing** for zip packages (AWS Signer) and image digest pinning.

## 5. Dependencies

- Lockfiles committed; Dependabot / Renovate; `npm audit` / `pip-audit` / `govulncheck` in CI.
- Private package proxies (CodeArtifact, Azure Artifacts, Artifact Registry remote repos).
- Pin GitHub Actions by SHA (`cicd-oidc`).

## Never

- Push `latest` to production or deploy by mutable tag.
- Enable ACR admin user, anonymous pull, or public ECR/Artifact Registry repositories for internal images (guard-blocked where detectable).
- Bake credentials into images or pass them as build args.
- Switch admission policies from Enforce to Audit to "get a deploy out"; fix the image instead.
