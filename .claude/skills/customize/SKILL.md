---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior on the **gateway + worker** product. Use AskUserQuestion to understand what they want before making changes.

Product surface: [docs/product-tree.md](../../docs/product-tree.md). Lifecycle: `./bin/zclaw`.

## Workflow

1. **Understand the request** - Ask clarifying questions
2. **Prefer an install skill** - If a skill exists (e.g. `/add-telegram`), invoke it instead of implementing manually
3. **Plan the changes** - Identify gateway/worker files to modify
4. **Implement** - Make changes directly to the code
5. **Test** - `./bin/zclaw restart` and verify via channel / logs

## Key files (this product)

| File | Purpose |
|------|---------|
| `src/gateway/` | Channels, HTTP API, queue, builder, orchestration |
| `src/worker/` | Workspace materialization, container spawn, outbound collection |
| `src/channels/` | Channel adapter registry (Zoho Cliq shipped; others via `/add-<channel>`) |
| `src/container-runner.ts` | Spawns agent containers from worker spawn context |
| `src/session-manager.ts` | Per-session `inbound.db` / `outbound.db` |
| `bin/zclaw` | Install/start/stop gateway + worker |

Do **not** look for classic host files (`src/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`, host `ncl`, `data/v2.db`) — they were removed.

## Common patterns

### Adding a messaging channel

Prefer `/add-<channel>` skills. They copy adapter code, wire the barrel, and install deps.

### Adding an MCP tool / provider

Prefer `/add-gmail-tool`, `/add-opencode`, etc. Config is a snapshot on the **gateway workspace**, materialized by the worker — not a classic central `container_configs` table.

### Changing assistant behavior

- Global defaults → `src/config.ts` / `.env`
- Per-agent persona → agent `CLAUDE.local.md` / Studio editor
- Multi-agent graphs → gateway orchestration (`MULTI_AGENT_ORCHESTRATION_ENABLED`)

### Changing deployment

Use `./bin/zclaw service install|start|stop|restart|status` with role `both` | `gateway` | `worker`. See [docs/product-tree.md](../../docs/product-tree.md).
