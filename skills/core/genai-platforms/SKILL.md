---
name: genai-platforms
description: Build and operate generative AI workloads safely on Amazon Bedrock, Azure OpenAI / Azure AI Foundry and Google Vertex AI (Gemini) - model access, private networking, identity, content safety guardrails, prompt-injection defence, RAG data security, logging, quotas and cost controls. Use when building a chatbot, RAG, agents or any LLM feature on a cloud provider.
---

# GenAI Platforms (Bedrock, Azure OpenAI, Vertex AI)

> Follow `cloud-guardrails` first: read-only by default, every change through `cloud-change-plan`, no direct production changes.

LLM features add three risks on top of normal cloud risk: **data leakage** (prompts and retrieved documents), **prompt injection** (untrusted text steering the model or its tools), and **runaway cost**. Design for all three from the first POC.

## 1. Identity and network

| | Bedrock | Azure OpenAI / AI Foundry | Vertex AI |
| --- | --- | --- | --- |
| Caller auth | IAM role (Lambda/ECS/EKS role); allow only `bedrock:InvokeModel*` on specific model / inference-profile ARNs | Managed identity + `Cognitive Services OpenAI User`; **disable key auth** (`disableLocalAuth: true`) | Service account with `roles/aiplatform.user` (or narrower custom role) |
| Private access | VPC interface endpoints `bedrock-runtime` (+ `bedrock`, `bedrock-agent-runtime`) with endpoint policies | Private endpoint, `publicNetworkAccess: Disabled` | Private Service Connect / VPC-SC perimeter around `aiplatform.googleapis.com` |
| Model access governance | Model access per account; SCP to deny non-approved models/regions | Deployments per model; Azure Policy for allowed models/SKUs | Org policy for allowed models (Model Garden governance), IAM |
| Data residency | Region choice; cross-region inference profiles move traffic across regions within a geography; decide explicitly | Deployment type: Standard (regional) vs Global / Data Zone | Regional endpoints vs global endpoint; decide explicitly |

Never put API keys in app config or code. If a key is unavoidable (third-party tool), store it in the secret manager and rotate.

## 2. Content safety guardrails

- **Bedrock Guardrails**: denied topics, content filters, PII redaction/blocking, contextual grounding checks, word filters. Attach by `guardrailIdentifier` + version on every `InvokeModel`/`Converse` call; enforce via IAM condition `bedrock:GuardrailIdentifier` where supported.
- **Azure AI Content Safety / content filters**: configure filter policies per deployment (hate, sexual, violence, self-harm, jailbreak/prompt shields, protected material). Do not request filter removal without legal/security approval.
- **Vertex AI**: safety settings per request (`safety_settings` thresholds), plus Model Armor for prompt/response screening (prompt injection, sensitive data, malicious URLs).

## 3. Prompt-injection and tool safety (RAG and agents)

- Treat retrieved documents, web pages, emails, tickets and tool outputs as **untrusted**. Separate them clearly from instructions in the prompt; never let them change system instructions.
- Least-privilege tools: an agent that can read tickets must not also be able to delete resources. Read-only tools by default; write tools require human confirmation (Bedrock Agents user confirmation, Foundry agent approvals, your own UI).
- Validate and constrain tool arguments server-side (allow-lists, schemas, size limits). Never pass model output straight into a shell, SQL query, `eval`, or a cloud API with broad permissions.
- Output handling: escape model output in UIs (XSS), never render untrusted markdown links/images that can exfiltrate data via URLs.
- Rate-limit per user; cap tokens per request and per session.

## 4. RAG data security

- Index only data the end user is allowed to see; enforce **document-level access control at query time** (metadata filters with the user's groups), not just at ingest.
- Classify sources; exclude secrets and regulated data unless the design explicitly covers them.
- Vector stores private (OpenSearch Serverless with network/data policies, Azure AI Search with private endpoint + RBAC, Vertex AI Vector Search / AlloyDB with private networking), encrypted with CMK where required.
- Keep embeddings and source documents in the same residency region.

## 5. Logging, privacy and abuse monitoring

- Bedrock: model invocation logging to S3/CloudWatch (contains prompts: treat as sensitive, restrict and encrypt). Providers do not use your prompts to train base models; document this for privacy reviews.
- Azure OpenAI: diagnostic settings to Log Analytics; understand abuse monitoring data retention; modified abuse monitoring requires a Microsoft approval process.
- Vertex AI: Cloud Audit Logs (Data Access for prompts, if enabled), request-response logging to BigQuery if configured; Google does not use customer data to train models without permission; zero data retention options where offered.
- Never log full prompts containing user PII to general-purpose logs; use a dedicated, access-restricted sink with retention limits.

## 6. Quotas and cost

- On-demand token pricing scales with traffic and prompt size; RAG and agents multiply tokens. Estimate with `finops-preflight` (tokens/request × requests/day × price).
- Set per-environment quotas/TPM limits (Azure deployment TPM, Bedrock service quotas, Vertex quotas) and budgets with alerts.
- Use smaller models for routing/classification, prompt caching (`llm-prompt-caching`), batch inference for offline jobs (`llm-batch-processing`).
- **Provisioned throughput / PTUs** are large commitments: humans decide (guarded by `finops-preflight`).

## 7. Quick-start IaC sketches (validate against current provider versions)

```hcl
# AWS: least-privilege invoke on one model / inference profile
data "aws_iam_policy_document" "invoke" {
  statement {
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ApplyGuardrail"]
    resources = [var.inference_profile_arn, var.foundation_model_arn, var.guardrail_arn]
  }
}
```

```bicep
// Azure: OpenAI account with keys disabled and private-only access
resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: name
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: name
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny' }
  }
}
```

```hcl
# GCP: dedicated SA for the chatbot backend, project-scoped Vertex user
resource "google_service_account" "chatbot" { account_id = "chatbot-backend" }
resource "google_project_iam_member" "vertex" {
  project = var.project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.chatbot.email}"
}
```

## 8. Pre-launch checklist

- [ ] Keyless auth, private networking, scoped IAM
- [ ] Guardrails/content filters configured and tested with red-team prompts (jailbreaks, injection via documents, PII extraction)
- [ ] Tool permissions minimal; write actions require confirmation
- [ ] RAG access control enforced per user at query time
- [ ] Prompt/response logging decision documented (what, where, retention, who can read)
- [ ] Quotas, budgets, anomaly alerts
- [ ] Evaluation set and regression tests for answer quality and safety
- [ ] Incident plan for harmful output or data leakage
