```
███████╗   ██████╗  ██╗        █████╗   ██╗    ██╗
╚══███╔╝  ██╔════╝  ██║       ██╔══██╗  ██║    ██║
  ███╔╝   ██║       ██║       ███████║  ██║ █╗ ██║
 ███╔╝    ██║       ██║       ██╔══██║  ██║███╗██║
███████╗  ╚██████╗  ███████╗  ██║  ██║  ╚███╔███╔╝
╚══════╝   ╚═════╝  ╚══════╝  ╚═╝  ╚═╝   ╚══╝╚══╝
```

ZClaw is a personal AI assistant. Agents run in their own Linux containers, behind a gateway that receives messages and a worker that prepares each session and starts the container.

## Install

macOS, Linux, or Windows via WSL2. Clone the repo and run the setup script:

```bash
git clone https://github.com/subbarao-mm-1754/nanoclaw.git
cd nanoclaw
bash zclaw.sh
```

The script installs Node.js, pnpm, and a container runtime if they are missing. It then sets up OneCLI, builds the agent image, and starts the gateway and worker.

Check that it is running:

```bash
./bin/zclaw status
./bin/zclaw logs -f
```

Stop or start it later with `./bin/zclaw stop` and `./bin/zclaw start`.

## Features

- **Isolated agents** — each session runs in its own container. The agent can only see directories that are explicitly mounted.
- **Gateway and worker** — the gateway handles channels, the message queue, schedules, and delivery. The worker materializes the workspace and collects outbound messages. They talk over HTTP and can run on the same machine or on separate machines.
- **Two-database sessions** — each session uses `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). One writer per file. No IPC and no stdin piping.
- **Messaging channels** — Cliq ships with the product. Other channels (Discord, Slack, Telegram, WhatsApp, and more) are added with `/add-<channel>` skills.
- **Per-agent workspace** — each agent has its own instructions, memory, container config, and mounts.
- **Flexible routing** — one agent per channel, one agent shared across channels, or several channels folded into a single conversation.
- **Scheduled tasks** — recurring jobs that run an agent and can send a message back.
- **Web access** — search and fetch pages from the web. Optional live browser streaming.
- **Multi-agent orchestration** — an orchestrator can coordinate specialist agents through gateway agent-to-agent routing. Disable it with `MULTI_AGENT_ORCHESTRATION_ENABLED=false`.
- **Credential vault** — API keys and OAuth tokens stay in OneCLI. They are injected at request time and are not written into the container environment or the chat.
- **Container runtimes** — Docker-compatible runtimes: Colima or Docker Desktop on macOS, Podman on Linux and WSL2. Apple Container is an optional macOS runtime.
- **Service control** — `./bin/zclaw` installs, starts, stops, and tails logs for the gateway and the worker.

## How it runs

```
channels → gateway (queue, schedules, delivery) → worker (workspace + spawn) → agent container
           ↑________________ outbound collector + delivery ________________↑
```

The gateway stores messages and asks the worker to process them. The worker writes the session inbound database and starts the container. The agent reads that database, runs, and writes the outbound database. The worker collects those messages and the gateway delivers them.

## Requirements

- macOS, Linux, or Windows via WSL2
- Node.js 26.13.0+ and pnpm 10+
- A container runtime (Colima or Docker Desktop on macOS; Podman on Linux and WSL2)
- OneCLI for credential storage (or the built-in credential proxy)

## License

MIT
