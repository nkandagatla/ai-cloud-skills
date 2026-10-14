---
name: llm-batch-processing
description: Use batch APIs to cut LLM cost for work that does not need an immediate answer - Claude Message Batches, Amazon Bedrock batch inference, Azure OpenAI Global/Data Zone Batch, Vertex AI batch prediction and OpenAI Batch - when to batch, building JSONL/requests with custom ids, submitting and polling, handling partial failures and retries, combining with prompt caching, idempotent pipelines, security of input/output files, and cost estimation. Use when processing many LLM requests offline (evaluations, classification, enrichment, summarisation, embeddings, document processing, nightly jobs).
---

# LLM Batch Processing

Load `engineering-guardrails` and `llm-app-cost-control` first. Batch APIs trade latency (minutes to 24 hours) for a large discount (commonly around 50% off standard pricing; confirm the current rate per provider and model) and separate quota, so bulk jobs do not starve interactive traffic.

## 1. When to batch

| Batch it | Keep it synchronous |
| --- | --- |
| Evaluations / regression suites for prompts | User-facing chat and agents |
| Classification, tagging, extraction over backlogs | Anything with a user waiting |
| Nightly summaries, report generation | Tool loops that depend on the previous answer |
| Embeddings / enrichment of large corpora | Low volume (overhead not worth it) |
| Translating or rewriting content libraries | Requests needing streaming |

Rule of thumb: if the result is needed later than ~1 hour and there are more than a few hundred requests, batch.

## 2. Pipeline design (all providers)

1. **Build requests** from source records with a deterministic `custom_id` (e.g. `ticket-48213-v3`), so results can be matched (results come back in any order) and re-runs are idempotent.
2. **Dry-run** one request synchronously to catch validation errors before submitting thousands.
3. **Chunk** large jobs (provider limits on request count and file size); one batch per chunk; record batch ids in a job table.
4. **Submit** with a dedicated service identity (no personal keys).
5. **Poll** at a modest interval (≥ 60 s) or use completion notifications where offered; never tight loops.
6. **Collect** results by `custom_id`; write to the destination idempotently (upsert).
7. **Retry** only failed/expired items: validation errors need a fixed request; server errors/expired items can be resubmitted in a new batch.
8. **Record cost**: tokens per item from result usage fields; compare with the estimate.
9. **Clean up** input/output files according to retention rules.

## 3. Claude API: Message Batches

```python
import anthropic, time
client = anthropic.Anthropic()          # key from secret manager / env, never in code

SYSTEM = [{"type": "text", "text": CLASSIFIER_INSTRUCTIONS, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]

requests = [
    {
        "custom_id": f"ticket-{t['id']}",
        "params": {
            "model": "claude-haiku-5-5",          # smallest model that meets the quality bar
            "max_tokens": 200,
            "system": SYSTEM,
            "messages": [{"role": "user", "content": t["text"]}],
        },
    }
    for t in tickets
]

batch = client.messages.batches.create(requests=requests)        # limits: ~100k requests or 256 MB per batch
while (b := client.messages.batches.retrieve(batch.id)).processing_status != "ended":
    time.sleep(60)

for r in client.messages.batches.results(batch.id):
    if r.result.type == "succeeded":
        save(r.custom_id, r.result.message.content[0].text, r.result.message.usage)
    elif r.result.type == "errored" and r.result.error.error.type == "invalid_request_error":
        flag_for_fix(r.custom_id)              # fix request before resending
    else:
        queue_retry(r.custom_id)               # server error, expired, canceled
```

- Most batches finish within an hour; anything not finished within 24 hours expires. Results are downloadable for a limited period (29 days at the time of writing); store what you need.
- Not billed for errored/canceled/expired requests.
- **Stack with prompt caching**: identical `cache_control` blocks on every request; to improve hit rates, send one request with the shared prefix (1-hour TTL) first, then submit the batch. Cache hits inside batches are best-effort.
- Streaming is not supported in batches.

## 4. Amazon Bedrock: batch inference

- Put JSONL records (`{"recordId": "...", "modelInput": { ...model-native request body... }}`) in S3, then create a job:

```bash
aws bedrock create-model-invocation-job \
  --job-name tickets-2026-10-09 \
  --model-id <model-or-inference-profile-id> \
  --role-arn arn:aws:iam::111122223333:role/bedrock-batch-tickets \
  --input-data-config '{"s3InputDataConfig":{"s3Uri":"s3://acme-llm-batch-dev/in/tickets-2026-10-09.jsonl"}}' \
  --output-data-config '{"s3OutputDataConfig":{"s3Uri":"s3://acme-llm-batch-dev/out/"}}' \
  --profile acme-dev --region us-east-1
aws bedrock get-model-invocation-job --job-identifier <job-arn> --query status
```

- Creating a job is a change (cloud-guard asks in nonprod); prod jobs run from the pipeline.
- Service role: read the input prefix, write the output prefix, KMS for the bucket key; nothing else. Buckets private, encrypted, with lifecycle expiry.
- Check minimum/maximum records per job and supported models in the current docs. Prompt caching does **not** apply to Bedrock batch jobs.

## 5. Azure OpenAI: Global Batch / Data Zone Batch

- Deploy the model as **Global-Batch** or **Data Zone Batch** (separate enqueued-token quota; Data Zone keeps processing within the data zone). Global Batch may process in any Azure OpenAI region, so check data-residency requirements.
- Input: JSONL lines `{"custom_id": "...", "method": "POST", "url": "/chat/completions", "body": {"model": "<deployment-name>", "messages": [...], "max_tokens": 200}}` (plain UTF-8, no BOM).

```python
from openai import OpenAI
from azure.identity import DefaultAzureCredential, get_bearer_token_provider
tp = get_bearer_token_provider(DefaultAzureCredential(), "https://ai.azure.com/.default")   # Entra ID, no API key
client = OpenAI(base_url="https://<resource>.openai.azure.com/openai/v1/", api_key=tp)

f = client.files.create(file=open("tickets.jsonl", "rb"), purpose="batch")
job = client.batches.create(input_file_id=f.id, endpoint="/chat/completions", completion_window="24h")
# poll client.batches.retrieve(job.id) every >= 60 s; then read output_file_id and error_file_id
```

- Limits (check current docs): ~100k requests and ~200 MB per file; enable dynamic quota to reduce enqueued-quota failures.

## 6. Vertex AI: batch prediction (Gemini)

- Input from Cloud Storage JSONL or a BigQuery table; output to GCS or BigQuery. Create via the Vertex AI SDK (`BatchPredictionJob`) or console with a dedicated service account that can read the input and write the output only.
- Batch pricing is discounted versus online prediction for supported Gemini models; confirm on the pricing page.
- Keep input/output buckets/datasets in the same region as the job; apply VPC-SC if the project is in a perimeter.

## 7. OpenAI (direct)

Same JSONL format and `files.create(purpose="batch")` → `batches.create(completion_window="24h")` flow as Azure; keys from a secret manager; project-scoped keys with spend limits.

## 8. Cost estimate before submitting

```
items × (avg_input_tokens × price_in_batch + avg_output_tokens × price_out_batch)
  − cache savings (Claude: cached prefix tokens × (price_in − price_cache_read))
```

Sample 50 items synchronously to measure average tokens and quality, then extrapolate. State the estimate in the PR/ticket (`finops-preflight`); large jobs need approval like any other spend.

## 9. Security and data handling

- Input/output files contain your data (often personal data): private, encrypted buckets/containers, least-privilege service identities, lifecycle deletion, no public links, same residency rules as the source data.
- Do not include secrets in prompts. Redact or pseudonymise personal data the task does not need.
- Treat model outputs as untrusted before writing them back to systems (validate against a schema).

## Never

- Batch user-facing or latency-sensitive work, or submit large jobs without a dry run and a cost estimate.
- Use personal API keys or broad roles for batch jobs; store input/output data in public or unencrypted storage.
- Retry a whole batch when only some items failed (double cost), or write results without matching on `custom_id`.
