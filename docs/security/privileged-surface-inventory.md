# Privileged-surface inventory

Status: verified 2026-11-11 at `9116ad3`. This file replaces the earlier assertion that
connector/tool/memory/prompt surfaces simply do not exist. They partly do; this records what
was actually searched, what each surface can reach, and the residual risk.

## Searches performed

```
rg -l -i "connector|mcp|plugin|tool registry|tool_registry|delegat|sub-?agent|spawnAgent|prompt|llm|completion" \
  --glob '!**/dist/**' --glob '!**/node_modules/**' .
find packages/tools/src packages/agents/src packages/founder/src -maxdepth 2 -type f
rg -n "LocalConnector|Connector|ToolRegistry|plugin|delegate|spawn" apps/host/src packages/*/src
rg -n -i "memory|prompt|instruction|context" packages/learning/src packages/founder/src apps/host/src
rg -n "connector|gmail|notion|memory|learning|tool|plugin" apps/host/src/server.ts
```

## Findings

- **Connector surface exists but is read-only evidence intake.**
  `packages/founder/src/local-connectors.ts` defines
  `AuthorizedLocalConnectorEvidenceReader`. It performs a separate `read_evidence`
  authorization before every provider request, accepts only loopback HTTP, rejects redirects,
  bounds responses, validates every field and derives `source_id` from the configured resource
  and provider id rather than trusting provider-supplied provenance. It exposes only
  `searchGmail` and `listNotionApplications`; there is no write, tool invocation or action
  method. Host routes `/v1/founder/gmail/search` and `/v1/founder/notion/applications` return
  evidence only.
- **Tool/plugin surface is metadata-only.**
  `packages/tools/src/tool-service.ts` installs/enables/disables validated Plugin metadata.
  `invoke()` is deliberately absent because no adapter execution model exists; no host code
  calls a plugin registry. `packages/tools/tests/tool-service.test.ts` now asserts the absence
  of an invocation method.
- **Agent delegation is not present.**
  `packages/agents/src/agent-runner.ts` is a lifecycle conformance harness that explicitly
  does not invoke tools or execute Task actions. `apps/host/src/runtime.ts` composes one
  `AgentExecutionPort` through `ManagedExecutionPort`; `packages/orchestration/src/index.ts`
  requires an exact `execute` grant for each Agent/Task and `coordinate` grants for every
  coordinated Agent. There is no sub-agent spawn or tool-scope delegation path.
- **Memory writes are approval-gated; memory is not a privileged decision input.**
  `packages/learning/src/learning-service.ts` requires a human-authorized, content-bound,
  single-use, expiring approval before permanent promotion. `packages/founder/src/local-runtime.ts`
  reads vault evidence and connector evidence; it does not consume LearningService memory as
  authorization or lifecycle input. `packages/learning/tests/memory-approval.test.ts` covers
  missing, unknown, expired, replayed and altered-content approvals.
- **Prompt/instruction handling does not reach a model or privileged action.**
  No LLM client, prompt template, tool loop or sub-agent spawn exists in the runtime. Task
  name/description/env are data passed to the fixed `local.exec` argv; the live
  `tools/security/adversarial-drill.mjs` case 17 proves hostile instruction text is not copied
  into evidence and does not alter the declared argv digest. Model-level prompt injection is
  therefore unmeasured rather than claimed defeated.

## Residual risk

The connector result is still untrusted content that a future model could consume; no model
consumer exists today. A future connector/tool/memory consumer must preserve the exact
authorization, source provenance, approval and verifier boundaries above. Memory approval
protects writes, not the epistemic truth of the content. Linux live measurements apply only to
the sandbox paths exercised in Security; macOS and rootless Docker remain unmeasured.
