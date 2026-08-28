---
name: llm-model-probe
description: Check an OpenAI-compatible model API when the user says "проверь модель" or "test model" and provides a model ID, API key, and site/Base URL. Use the installed llm-probe-agent workflow; never run rate-limit tests unless explicitly requested.
---

# LLM model probe

The global `llm-probe-pi` input extension normally handles these requests before the model sees them. This skill is a fallback and a guide for interpreting the result.

Expected user format:

```text
Проверь модель <MODEL_ID> <API_KEY> <SITE_OR_BASE_URL>
```

Quick mode:

```text
Быстро проверь модель <MODEL_ID> <API_KEY> <SITE_OR_BASE_URL>
```

Rules:

1. Do not ask the user to create configuration files.
2. Do not place an API key in process arguments, reports, source files, or the final response.
3. Use `llm-probe-agent`, which discovers the API endpoint and runs `llm-probe`.
4. A normal request uses `full`; a request beginning with `Быстро` uses `quick`.
5. Never run the separate rate-limit probe unless the user explicitly asks for it.
6. Report the selected endpoint, base reachability, `response.model`, tools, reasoning, vision, streaming, TTFT, tokens/second, and context results.
7. Distinguish `context_largest_accepted_tokens` from `context_confirmed_retrieval_tokens`.
8. Do not claim upstream model authenticity from self-identification, `response.model`, or writing style alone.
9. If the extension is not loaded, tell the user to run `/reload` once or restart Pi. Do not request the API key again if it is already present in the message.
