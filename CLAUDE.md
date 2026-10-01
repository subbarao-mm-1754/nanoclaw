# NanoClaw (gateway + worker)

Personal Claude assistant. See [README.md](README.md) and [docs/product-tree.md](docs/product-tree.md).

This checkout is a **fresh** gateway + worker product — there is no v1→v2 migration path. Do not resurrect `migrate-v2.sh`, `/migrate-from-v1`, or the classic single-process host (`src/index.ts`, router, host-sweep, host `ncl`).

## Quick Context

**Product runtime is two processes:**

| Process | Entry | Responsibility |
|---------|-------|----------------|
| **Gateway** | `src/gateway/` | Channels, HTTP API, message queue, builder/orchestration, outbound delivery |
| **Worker** | `src/worker/` | Workspace materialization, container spawn, outbound collection |

They talk over HTTP (`GATEWAY_WORKER_URL` / `GATEWAY_PUBLIC_URL`) and can run on the same machine or different ones. Lifecycle: `./bin/zclaw` (see [docs/product-tree.md](docs/product-tree.md)).

Shared helpers used by the worker live under `src/` next to gateway/worker: `container-runner`, `session-manager`, `container-runtime`, `container-config`, `group-init`, `claude-md-compose`, session DB helpers, channel registry.

**Everything is a message** between host-side session DBs and the agent container — no IPC, no stdin piping. Per-session `inbound.db` / `outbound.db` remain the container IO surface.

## Entity model (gateway)

Agent identity and routing live in **gateway.db** (not classic `data/v2.db`):

- Workspaces / agents (folder, container config snapshot, `cli_scope`, defaults)
- Conversations, messages, channel bindings
- Optional orchestration (orchestrator members, graphs, runs) when multi-agent is enabled

Worker jobs carry a workspace **manifest**; the worker does not open a classic central `v2.db`.

## Two-DB session split

Each session has **two** SQLite files under the worker session directory:

- `inbound.db` — host/worker writes, container reads. `messages_in`, routing, destinations, pending_questions, processing_ack.
- `outbound.db` — container writes, host/worker reads. `messages_out`, session_state.

Exactly one writer per file. Heartbeat is a file touch at `/workspace/.heartbeat`. Host uses even `seq` numbers, container uses odd.

## Key files

| File | Purpose |
|------|---------|
| `src/gateway/index.ts` | Gateway entry: DB, channels, HTTP server, message processor, LangGraph nudge loop |
| `src/worker/index.ts` | Worker entry: container runtime, outbound collector, HTTP API |
| `src/gateway/processor.ts` | Queue → worker process-message → delivery / A2A routing |
| `src/gateway/orchestration/` | Multi-agent LangGraph + gateway A2A (`channel_type=agent`) |
| `src/session-manager.ts` | Session folders; open `inbound.db` / `outbound.db`; job routing/destinations |
| `src/container-runner.ts` | Spawns containers from worker `WorkerSpawnContext` + OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Runtime selection (Docker/Podman/Apple), orphan cleanup |
| `src/channels/` | Channel adapter registry (Zoho Cliq shipped; others via `/add-<channel>` skills) |
| `src/providers/` | Host-side provider container-config (`claude` baked in) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, providers, MCP tools, destinations |
| `container/skills/` | Container skills (`onecli-gateway`, `welcome`, `self-customize`, `agent-browser`, …) |
| `bin/zclaw` + `setup/services/` | Install/start/stop gateway + worker as OS services |

## Multi-agent / LangGraph

Optional but **on by default** (`MULTI_AGENT_ORCHESTRATION_ENABLED`). Orchestrators coordinate specialists via **gateway** agent-to-agent routing (`src/gateway/orchestration/`), not the removed classic `src/modules/agent-to-agent` / central `agent_destinations` path.

Disable with `MULTI_AGENT_ORCHESTRATION_ENABLED=false`. Solo `/build` + `/use` flows are unchanged.

## Channels and providers (skill-installed)

Trunk ships registry/infra + Zoho Cliq for this product tree. Extra adapters and providers live on sibling branches and are copied in by skills (`/add-discord`, `/add-opencode`, …).

## Container config

Per-agent container config is a snapshot on the gateway workspace, materialized into the worker workspace as `container.json` at prepare time. Agents do **not** use host `ncl` — that CLI was removed with the classic host. Prefer gateway APIs / Studio.

## Secrets / OneCLI

API keys and OAuth tokens are managed by the OneCLI gateway. Secrets are injected into containers at request time — none via env vars or chat context. See `container/skills/onecli-gateway/SKILL.md`. Host wiring: `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

### Gotcha: auto-created agents start in `selective` secret mode

When the worker first spawns a session, `onecli.ensureAgent` creates the agent in **selective** mode (no secrets assigned by default).

```bash
onecli agents list
onecli agents set-secret-mode --id <agent-id> --mode all
# or: onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>
```

No container restart needed after flipping mode — the next API call picks up credentials.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time install, auth, service config |
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials |
| `/add-<channel>` | Install an optional messaging channel |

Classic `/init-first-agent` (central `v2.db` + `scripts/init-first-agent.ts`) is **not** part of this product — create agents via gateway `/build` / Studio.

## Development

```bash
pnpm run build
pnpm run dev:gateway   # or: pnpm run dev
pnpm run dev:worker
./container/build.sh
pnpm test
./bin/zclaw start|stop|restart|status
```

## Troubleshooting

| What | Where |
|------|-------|
| Gateway / worker logs | `logs/` (service logs via `./bin/zclaw logs`) |
| Setup logs | `logs/setup.log`, `logs/setup-steps/*.log` |
| Session DBs | Worker session dirs — `inbound.db` / `outbound.db` |

Container logs are lost after exit (`--rm`).

## Docs index

| Doc | Purpose |
|-----|---------|
| [docs/product-tree.md](docs/product-tree.md) | Gateway + worker product surface (source of truth) |
| [docs/setup-install.md](docs/setup-install.md) | OS install matrix + optional features |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Node host + Bun container split |
| [docs/architecture.md](docs/architecture.md) | Broader architecture (may still mention classic host in places) |

## Supply chain (pnpm)

`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`. Do not add `minimumReleaseAgeExclude` or `onlyBuiltDependencies` without human approval. Prefer `pnpm install --frozen-lockfile` in CI/container builds.

## CJK fonts

Default image omits CJK fonts. To enable: set `INSTALL_CJK_FONTS=true` in `.env`, run `./container/build.sh`, then `./bin/zclaw restart`.
