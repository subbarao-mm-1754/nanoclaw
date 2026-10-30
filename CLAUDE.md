# ZClaw

Personal AI assistant, version 0.1. See [README.md](README.md).

Two processes:

| Process | Entry | Responsibility |
|---------|-------|----------------|
| **Gateway** | `src/gateway/` | Channels, queue, schedules, delivery |
| **Worker** | `src/worker/` | Workspace, container spawn, outbound collection |

They talk over HTTP. Start and stop them with `./bin/zclaw`.

Each session has two SQLite files: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). One writer per file.

Agents run in containers. API keys stay in OneCLI and are injected at request time.

Do not bring back the old single-process host (`src/index.ts`, router, host-sweep, host `ncl`).

## Development

```bash
pnpm run build
pnpm run dev:gateway
pnpm run dev:worker
./container/build.sh
pnpm test
./bin/zclaw start|stop|restart|status
```

Logs: `./bin/zclaw logs` and `logs/`.
