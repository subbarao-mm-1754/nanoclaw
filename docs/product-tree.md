# NanoClaw product tree (gateway + worker)

This fork’s **product** is two separately deployable services:

| Process | Entry | Responsibility |
|---------|-------|----------------|
| **Gateway** | `dist/gateway/index.js` | Channels, HTTP API, message queue, builder/orchestration, callbacks |
| **Worker** | `dist/worker/index.js` | Workspace materialization, container spawn, outbound collection |

They communicate over HTTP (`GATEWAY_WORKER_URL` / `GATEWAY_PUBLIC_URL`) so they can run on the **same machine** or **different machines**.

Lifecycle:

```bash
./bin/nanoclaw service install --role both   # or gateway | worker
./bin/nanoclaw start|stop|restart|status
./bin/nanoclaw logs -f
```

## Core (keep)

- `src/gateway/` — gateway process
- `src/worker/` — worker process
- Shared runtime used by worker/gateway: `container-runner`, `container-runtime`, `container-config`, `session-manager`, `db/`, `channels/` (registry + adapters you enable), `config`, `log`, `group-init`, `claude-md-compose`, …
- `container/agent-runner/` — agent inside Docker
- OneCLI (or `/use-native-credential-proxy`) — credentials
- Docker / Node / pnpm
- `setup/services/` + `bin/nanoclaw` — install & start/stop
- Channel you use today: Zoho Cliq (`src/channels/zoho-cliq.ts`, gateway multi-account)

## Optional (install when needed — do not treat as default product)

| Capability | How |
|------------|-----|
| Extra messaging channels | `/add-<channel>` skills (Discord, Slack, Telegram, …) |
| Knowledge DB (Postgres) | Set `KNOWLEDGE_DATABASE_URL` + Postgres |
| Live browser streaming | `LIVE_BROWSER_ENABLED=true` |
| Multi-agent LangGraph orchestration | On by default; disable with `MULTI_AGENT_ORCHESTRATION_ENABLED=false` |
| Ollama / OpenCode / Codex providers | Provider skills |
| Mount allowlist tooling | `/manage-mounts` |
| Apple Container | `/convert-to-apple-container` |

## Not part of this product surface

| Item | Notes |
|------|--------|
| Classic single-process host (`src/index.ts`, router, host delivery, host-sweep) | **Removed** — gateway + worker replace it |
| Host `ncl` / `scripts/chat.ts` / CLI-agent setup | **Removed** — use `./bin/nanoclaw` + gateway APIs |
| Classic channel setup drivers (`setup/channels/*`, `init-first-agent`) | **Removed** — install adapters via skills / `setup/add-zoho-cliq.sh` as needed |
| Classic host modules (approvals/permissions/scheduling/self-mod host wiring) | **Removed** — not on the gateway/worker path |
| Upstream channel install scripts you don’t use | Optional; Zoho helpers kept under `setup/add-zoho-cliq.sh` |
| `.claude/skills/add-*` for unused channels | Skill docs only — safe to ignore until needed |

## Split machines

**Gateway host**

```bash
export NANOCLAW_ROLE=gateway
export GATEWAY_HOST=0.0.0.0
export GATEWAY_PORT=8090
export GATEWAY_WORKER_URL=http://<worker-host>:8080
export GATEWAY_AUTH_TOKEN=<shared-secret>
export WORKER_AUTH_TOKEN=<shared-secret>
./bin/nanoclaw service install --role gateway
```

**Worker host**

```bash
export NANOCLAW_ROLE=worker
export WORKER_HOST=0.0.0.0
export WORKER_PORT=8080
export GATEWAY_PUBLIC_URL=http://<gateway-host>:8090
export WORKER_AUTH_TOKEN=<shared-secret>
export GATEWAY_AUTH_TOKEN=<shared-secret>
./bin/nanoclaw service install --role worker
```

Worker needs Docker + agent image build on that machine. Gateway needs channel credentials / OneCLI as configured.
