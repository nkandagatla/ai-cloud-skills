---
name: llm-app-cost-control
description: Control cost and token usage in applications that call LLM APIs (Anthropic Claude API, Amazon Bedrock, Azure OpenAI, Vertex AI, OpenAI) - token accounting per request, model routing, prompt caching, batch APIs, max_tokens and output limits, context trimming for chat history and RAG, response caching, rate limits, per-tenant budgets and quotas, cost observability and alerts. Use when building or reviewing a chatbot, RAG system, agent or any LLM feature, or when an LLM bill spikes.
---

# LLM Application Cost Control

Load `engineering-guardrails` and `genai-platforms` first. Pricing and limits change frequently: look up current per-model prices and cache multipliers on the provider's pricing page before estimating.

## 1. Know the unit economics

For each feature, estimate per request: input tokens (system + tools + history + retrieved context + user message), output tokens (including reasoning/thinking where billed as output), and calls per user action (agents make several). Then:

```
cost/request ≈ in_tokens × price_in + cached_tokens × price_cache_read + cache_write_tokens × price_cache_write + out_tokens × price_out
monthly ≈ cost/request × requests/user/day × active users × 30
```

Record it in the design doc and in `finops-preflight` output. Set a target cost per conversation / per resolved ticket.

## 2. Levers (biggest first)

1. **Model routing**: small/fast model for classification, extraction, routing, summarising; mid-tier for most generation; top-tier only for hard reasoning. A router (rules or a small model) picks per request; fall back up a tier on low confidence.
2. **Prompt caching** (full guide: `llm-prompt-caching`): put stable content first (system prompt, tool definitions, long reference docs, few-shot examples) and mark a cache breakpoint after it; dynamic content (user message, timestamps) goes after. Cache reads cost a fraction of normal input; writes cost slightly more, so caching only pays when the prefix is reused within the cache lifetime (typically minutes; longer TTL options cost more to write). Check the response `usage` fields (`cache_read_input_tokens`, `cache_creation_input_tokens` on the Claude API) to confirm hits. Content below the model's minimum cacheable length is silently not cached.
3. **Trim conversation history**: keep the last N turns verbatim, summarise older turns into a running summary, drop tool results once used; cap total input tokens per request.
4. **RAG discipline**: retrieve fewer, better chunks (rerank, top-k 3-8), chunk sizes tuned, deduplicate, strip boilerplate; do not stuff whole documents.
5. **Output limits**: set `max_tokens` per use case; ask for structured, concise output (JSON schema); stop sequences.
6. **Batch APIs** (full guide: `llm-batch-processing`) for offline/bulk work (evaluations, enrichment, nightly summaries): large discounts versus synchronous calls in exchange for latency.
7. **Response caching**: cache deterministic answers (FAQ, classification of identical inputs) keyed by normalised input + model + prompt version, with TTL; semantic caching only with a tight similarity threshold and per-tenant isolation.
8. **Reasoning effort**: lower effort/thinking budgets for simple tasks where the model supports it.
9. **Avoid waste**: no retries without backoff, idempotency for retried requests, cancel streaming when the user leaves, no duplicate calls from UI double-submits.

## 3. Guardrails in code

```python
# Sketch: enforce budgets before calling the model (adapt to your stack)
MAX_INPUT_TOKENS = 12_000
MAX_OUTPUT_TOKENS = 800

def call_llm(tenant_id: str, messages: list[dict], model: str) -> Response:
    est_in = count_tokens(messages, model)            # provider token-count API or tokenizer
    if est_in > MAX_INPUT_TOKENS:
        messages = summarise_older_turns(messages, target=MAX_INPUT_TOKENS)
    budget.check_and_reserve(tenant_id, estimate_cost(model, est_in, MAX_OUTPUT_TOKENS))   # raises when over quota
    resp = client.messages.create(model=model, max_tokens=MAX_OUTPUT_TOKENS, messages=messages, system=SYSTEM_PROMPT_CACHED)
    budget.settle(tenant_id, actual_cost(resp.usage, model))
    metrics.emit("llm.tokens", resp.usage, tags={"tenant": tenant_id, "model": model, "feature": "support-chat"})
    return resp
```

- **Per-tenant / per-user quotas** (tokens or dollars per day) and rate limits in your API gateway or service.
- **Kill switch / degrade mode**: feature flag to route to a cheaper model or disable non-essential LLM features when spend spikes.
- Provider-side limits: workspace/project spend limits and rate limits (Claude Console workspaces), Azure OpenAI deployment TPM quotas, Bedrock and Vertex quotas, cloud budgets with alerts.
- Secrets: API keys in a secret manager or keyless auth via cloud IAM (`genai-platforms`); never in code or front-end bundles (anyone could spend on your account).

## 4. Observability

Emit per request: model, prompt version, input/output/cached tokens, latency, cost estimate, tenant, feature, cache hit, outcome (resolved/escalated). Dashboards: cost per feature/tenant/day, cache hit rate, tokens per request distribution (p50/p95), top expensive prompts. Alerts: daily spend > budget %, sudden token-per-request increase (prompt regression, runaway agent loop), error/retry spikes.

Never log full prompts or completions containing personal data to general logs; use a restricted, retention-limited store if you need them for evaluation.

## 5. Agents and tool loops

- Cap steps per task (max tool calls / iterations), cap total tokens per task, and stop on repeated identical tool calls.
- Return compact tool results to the model (IDs and summaries, paginate, filter fields); the same principle as `token-saver`.
- Use smaller models for sub-steps; keep tool definitions few and short (they are sent every call).

## 6. Review checklist

- [ ] Cost per request and per month estimated; target set
- [ ] Model routing in place; top-tier not the default for everything
- [ ] Prompt caching on stable prefix; hits verified in usage data
- [ ] History trimming and RAG top-k limits
- [ ] `max_tokens` set per use case
- [ ] Batch API for offline work
- [ ] Per-tenant quotas, provider spend limits, budget alerts, kill switch
- [ ] Token/cost metrics per feature and tenant; no PII in logs

## Never

- Ship an LLM feature without `max_tokens`, quotas and cost metrics.
- Put API keys in client-side code, or let unauthenticated users trigger model calls without rate limits.
- Retry failed calls in tight loops, or let agent loops run without step/token caps.
