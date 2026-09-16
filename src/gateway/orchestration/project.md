## Multi-agent orchestration (Gateway)

Job-scoped **orchestrators** coordinate specialist agents via graph/loops and
agent-to-agent messaging. Solo `/build` + `/use` flows are unchanged when the
feature is off or when the builder chooses a single agent.

When a builder registers a fixed `graph`, the Gateway runs it in-process with
**LangGraph** (multi-user / multi-conversation isolated by run id). The
orchestrator remains the user-facing agent and may choose among allowed
branches; it cannot change the stored graph, loops, or max_iterations.

### Enable / disable (default: **on**)

```bash
# .env
MULTI_AGENT_ORCHESTRATION_ENABLED=true   # or false

# optional override in gateway.db
# key: multi_agent_orchestration_enabled  value: true|false

# optional LangGraph wait policy
# LANGGRAPH_NUDGE_AFTER_MS=1200000   # 20m
# LANGGRAPH_FAIL_AFTER_MS=3000000    # 50m → accept partial
# LANGGRAPH_NUDGE_INTERVAL_MS=60000
```

Restart **gateway** (and **worker** if already running) after changing the env flag.

### Cliq UX

| Command | Behavior |
|---------|----------|
| `/build …` | Builder analyzes single agent vs orchestrator. Asks before multi-agent. `/register` creates. |
| `/use <name>` | Bind chat to an agent **or** orchestrator. |
| `/agents` | Lists both; orchestrators marked `[orchestrator]`. |

### Runtime

- Orchestrator workspaces have `agent_kind = orchestrator`.
- Members + graph live in gateway DB (`gateway_orchestrator_*`, `gateway_orchestration_runs`).
- Worker process-message gets `extra_destinations` so specialists are reachable via `send_message`.
- Agent-channel outbound is routed by the Gateway (not dropped by the collector).
- Fixed graphs: `src/gateway/orchestration/langgraph/` compiles JSON → StateGraph, drives waits/nudges/loops.

### Agent Studio

Open an orchestrator from **Your agents** (badge `orchestrator`). The editor shows:

- **Team** — specialist destinations
- **Graph & loops** — registered plan
- **Activity** — active run, recent runs, event timeline (auto-refresh ~4s)

APIs:

- `GET /v1/agents/:id/orchestration`
- `GET /v1/agents/:id/orchestration/runs`
- `GET /v1/agents/:id/orchestration/runs/:runId`

### Key files

- `src/gateway/orchestration/` — config, store, register, destinations, runtime
- `src/gateway/orchestration/langgraph/` — compile, runner, A2A side-effects, nudges
- `src/gateway/builder/prompt.ts` — builder instructions when enabled
- `src/gateway/builder/service.ts` — finalize create path
