---
name: llm-prompt-caching
description: Implement and verify prompt caching to cut LLM input cost and latency - how prefix caching works, what to cache, prompt layout for cache hits, cache breakpoints and TTLs on the Claude API, cachePoint on Amazon Bedrock, automatic caching on Azure OpenAI/OpenAI, Gemini context caching on Vertex AI, break-even maths, measuring hit rates from usage fields, common cache-busting mistakes, and keeping agent sessions cache-friendly. Use when building or reviewing any feature that sends repeated long prompts (system prompts, tools, documents, RAG context, chat history), or when LLM input costs are high.
---

# LLM Prompt Caching

Load `engineering-guardrails` and `llm-app-cost-control` first. Prices, minimum lengths and TTLs change: confirm on the provider's pricing and caching pages before committing numbers to a design.

## 1. How it works

Providers cache the **prefix** of a prompt. When a later request starts with exactly the same prefix (byte-for-byte, same model, same tool definitions and settings), the cached part is billed at a heavily discounted **cache-read** rate and processed faster. Anything after the first difference is processed normally. So:

- **Stable content first, variable content last.**
- **One changed character early in the prompt invalidates everything after it.**

Typical economics on the Claude API (multipliers of the base input price; check current values):

| Token type | Multiplier |
| --- | --- |
| Cache write, 5-minute TTL | 1.25× |
| Cache write, 1-hour TTL | 2× |
| Cache read | 0.1× (lower on some newer models) |
| Normal input after the cached prefix | 1× |

Break-even: with a 5-minute cache, the second request that reuses the prefix already saves money (1.25 + 0.1 < 2 × 1.0). With a 1-hour cache you need roughly two or more reads per write. Caching costs nothing to try: breakpoints are free, you only pay for writes and reads.

## 2. Prompt layout for cache hits

```
[ tool definitions ]                        ← stable, cached          (order: tools → system → messages)
[ system prompt + policies + few-shot ]     ← stable, cached          ← breakpoint 1
[ large reference docs / RAG corpus / codebase summary ] ← stable per session ← breakpoint 2
[ conversation history (older turns) ]      ← grows; cache incrementally   ← breakpoint 3 (last stable turn)
[ latest user message, timestamps, request ids ] ← changes every call: never before a breakpoint
```

Rules:

- Never put timestamps, request ids, user names, random sampling of examples or "today's date" in the system prompt; pass them in the final user turn.
- Keep tool definitions identical across requests (same order, same descriptions). Adding/removing a tool invalidates the whole cache.
- Serialize JSON deterministically (sorted keys) if you inject structured context.
- Keep model, thinking/effort settings and tool choice stable within a conversation; changing them can invalidate cached prefixes.
- Content shorter than the model's minimum cacheable length is silently not cached.

## 3. Claude API

Automatic caching (one top-level field, simplest):

```python
import anthropic
client = anthropic.Anthropic()          # key from env / secret manager, never in code

resp = client.messages.create(
    model="claude-sonnet-5-5",          # use your approved model id
    max_tokens=800,
    cache_control={"type": "ephemeral"},               # or {"type": "ephemeral", "ttl": "1h"}
    system=SYSTEM_PROMPT,                              # long, stable
    messages=history + [{"role": "user", "content": user_msg}],
)
u = resp.usage
print(u.cache_creation_input_tokens, u.cache_read_input_tokens, u.input_tokens, u.output_tokens)
```

Explicit breakpoints (up to 4 per request) when you need control over where cache entries are written:

```python
resp = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=800,
    tools=TOOLS,                                          # stable list
    system=[
        {"type": "text", "text": POLICIES_AND_INSTRUCTIONS},
        {"type": "text", "text": PRODUCT_CATALOG_DOC, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
    ],
    messages=[
        *older_turns[:-1],
        {**older_turns[-1], "content": [{"type": "text", "text": older_turns[-1]["content"], "cache_control": {"type": "ephemeral"}}]},
        {"role": "user", "content": user_msg},
    ],
)
```

- Longer-TTL breakpoints must come before shorter-TTL ones.
- Lookback: the system checks a limited window of blocks before each breakpoint for an existing entry; in long conversations move the breakpoint forward each turn (or use automatic caching) so it stays within reach.
- Total input = `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`.

## 4. Amazon Bedrock (Converse API)

```python
import boto3
br = boto3.client("bedrock-runtime", region_name="us-east-1")   # IAM role credentials

resp = br.converse(
    modelId=MODEL_OR_INFERENCE_PROFILE_ID,
    system=[{"text": SYSTEM_PROMPT}, {"cachePoint": {"type": "default"}}],     # add "ttl": "1h" only on models that support it
    toolConfig={"tools": [*TOOLS, {"cachePoint": {"type": "default"}}]},
    messages=[{"role": "user", "content": [{"text": user_msg}]}],
    inferenceConfig={"maxTokens": 800},
)
u = resp["usage"]
print(u.get("cacheReadInputTokens"), u.get("cacheWriteInputTokens"), u["inputTokens"])
```

- Checkpoints can sit in `toolConfig.tools`, `system` and `messages`; order is tools → system → messages; up to 4 per request; minimum tokens per checkpoint depend on the model.
- Bedrock prompt caching applies to on-demand inference, **not** to batch inference jobs.
- IAM: callers need only `bedrock:InvokeModel`/`Converse` on the specific model or inference profile (`genai-platforms`).

## 5. Azure OpenAI / OpenAI

- Caching is **automatic** for prompts above a minimum length (around 1,024 tokens) on supported models; no code change beyond prompt layout. Verify per model in the current docs.
- Check `usage.prompt_tokens_details.cached_tokens` (Chat Completions) or the equivalent field in the Responses API.
- A `prompt_cache_key` / `user` style parameter (where supported) can improve routing to the same cache for requests sharing a prefix.
- Same layout rules: static instructions, tools and documents first; dynamic content last.

## 6. Vertex AI (Gemini)

- **Implicit caching**: supported Gemini models discount repeated prefixes automatically; same layout rules apply. Check `usage_metadata.cached_content_token_count`.
- **Explicit context caching**: create a `CachedContent` resource (large documents, video, long system instructions) with a TTL, then reference it in requests. You pay a discounted rate for cached tokens plus **storage per hour** for the cache lifetime, so delete or shorten the TTL when idle. Good for many questions over the same large corpus.
- Explicit caches are regional resources: create them in the region where you call the model, and include them in data-residency reviews.

Verify minimum token counts, discounts and storage pricing on the Vertex AI pricing page for your model.

## 7. Measure (no measurement, no savings)

Log per request: model, prompt version, `input`, `cache_write`, `cache_read`, `output` tokens. Compute:

```
cache_hit_ratio   = cache_read / (cache_read + cache_write + uncached_input)
effective_in_cost = (uncached × price_in) + (cache_write × price_write) + (cache_read × price_read)
savings_vs_nocache = (all_input_tokens × price_in) − effective_in_cost
```

Alert when the hit ratio drops suddenly: usually someone added a timestamp to the system prompt, reordered tools, or changed a setting per request.

## 8. Common cache busters (review checklist)

- [ ] Dynamic values (date, user id, request id, A/B flags) in system prompt or tool descriptions
- [ ] Tools list built from a set/dict with non-deterministic order
- [ ] RAG chunks retrieved in different order for the same document set (sort them)
- [ ] Per-request model / thinking / effort / tool_choice changes
- [ ] Prefix below minimum cacheable length (nothing cached, no error)
- [ ] Traffic too sparse for the TTL (5-minute cache expiring between requests: use 1-hour TTL or batch the work)
- [ ] Different tenants' private data in a shared prefix (also a privacy issue: keep tenant data after the shared prefix)

## 9. Agent sessions (Claude Code and other coding agents)

Coding agents cache automatically; you keep the cache warm by not breaking the prefix:

- Avoid toggling MCP servers, plugins or tools mid-session (tool definitions are at the front of the prefix).
- Keep `CLAUDE.md`/`AGENTS.md` stable during a session; edit it between sessions.
- Long idle breaks let the cache expire; resume from a handoff note in a fresh session instead of re-sending a huge history (`ai-context-management`).
- `/usage` in Claude Code shows prompt cache statistics (share of input from cache, misses, likely causes).

## 10. Privacy and security

- Caches are scoped to your organisation/workspace by providers, but design as if cached prefixes are shared across your own users: never put one tenant's private data before a breakpoint that other tenants' requests reuse.
- Do not cache secrets; they should never be in prompts at all.
- Explicit caches (Vertex `CachedContent`) are stored resources: apply retention and deletion like any other data store.

## Never

- Put changing values before cached content, or assume caching works without checking the usage fields.
- Pay for 1-hour cache writes or explicit cache storage on traffic that never reads them.
- Mix tenants' private data into a shared cached prefix.
