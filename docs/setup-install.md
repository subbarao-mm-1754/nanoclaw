# Setup install matrix (what gets installed where)

This document describes what `bash nanoclaw.sh` / `pnpm run setup:auto` installs on each host OS, and what remains **optional** (skills / env flags). Source of truth for the container runtime installer is `setup/install-docker.sh`.

Windows is supported via **WSL2** (treat as Linux below).

---

## Quick matrix

| Component | macOS | Linux / WSL2 | Notes |
|-----------|--------|--------------|--------|
| **Homebrew** | Installed if missing (prompted in `nanoclaw.sh`) | — | Needed for Node / Colima / Docker CLI formulae |
| **Node.js 20+** | Installed if missing | Installed if missing | `setup/install-node.sh` |
| **pnpm** + `node_modules` | Yes | Yes | `setup.sh` / `pnpm install --frozen-lockfile` |
| **Container runtime** | See [macOS runtime](#macos-container-runtime) | See [Linux runtime](#linux-wsl2-container-runtime) | Worker spawns agent containers via `docker` CLI |
| **Agent image** | Built (`nanoclaw-agent…:latest`) | Built | `setup/container.ts` / `container/build.sh` |
| **OneCLI gateway + CLI** | Yes (local by default) | Yes (local by default) | `setup/onecli.ts` → `onecli.sh/install` |
| **OneCLI Postgres** | Compose container | Compose container | Pulled/started by OneCLI installer — not host `apt`/`brew` Postgres |
| **Anthropic credential** | Registered in OneCLI | Registered in OneCLI | `setup/auth.ts` |
| **Mount allowlist** | Written if missing | Written if missing | Often empty at first |
| **Gateway + worker OS services** | launchd | systemd (or nohup fallback) | `./bin/nanoclaw service install` |
| **`nanoclaw` CLI symlink** | `~/.local/bin/nanoclaw` | `~/.local/bin/nanoclaw` | Lifecycle: start/stop/status/logs |

On **`nanoclaw start` / `restart` / `service install`**, local OneCLI is
ensured first: if `ONECLI_URL` already responds healthy → skip; else run
`onecli start` and wait briefly. Remote OneCLI URLs are probed only.

Installers are **idempotent** where possible: if a binary/app is already present, setup skips reinstall and only ensures sockets/Compose/services as needed.

---

## macOS container runtime

Preference order in `setup/install-docker.sh`:

1. **Docker Desktop already installed** (`/Applications/Docker.app` or `~/Applications/Docker.app`) → **reuse it**. Do not install another engine.
2. **Else Colima already installed** → reuse Colima; ensure Docker CLI + Compose via Homebrew **formulae** (`docker`, `docker-compose`).
3. **Else** → install **Colima + Docker CLI + Compose** with Homebrew (`brew install colima docker docker-compose`).

**Docker Desktop is never installed by NanoClaw setup.** Only reused if the user already has it.

At container-step start time (`setup/container.ts`):

- Desktop present → `open -a Docker`
- Else Colima → `colima start` (blocks until ready)

---

## Linux / WSL2 container runtime

- Installs **Podman** + **`podman-docker`** (Docker CLI shim) via the distro package manager (`apt` / `dnf` / `yum` / `zypper` / `pacman`).
- Enables `podman.socket` (user + optional system) and ensures a Compose provider.
- Does **not** install Docker Engine (`get.docker.com`) or Docker Desktop.

The worker still invokes the `docker` binary; on this path that is the Podman shim.

If only Podman is present without the shim, setup installs `podman-docker`. If a working `docker` CLI is already present with Podman, setup treats it as already installed and refreshes sockets/Compose.

---

## OneCLI stack (both platforms)

Default local install runs the upstream OneCLI installer (Docker Compose based). Typical services:

| Service | Role |
|---------|------|
| `onecli` | Agent Vault gateway (often `http://127.0.0.1:10254`) |
| `postgres` | OneCLI’s database (container image, e.g. `postgres:*-alpine`) |

Also installs the **`onecli` CLI** (often under `~/.local/bin`) and writes `ONECLI_URL` into `.env`.

After setup, **`./bin/nanoclaw start`** (and `restart` / `service install`) will health-check that URL and run `onecli start` when the local gateway is down.

**Exceptions:**

- **Reuse** — existing OneCLI on the machine; no reinstall.
- **Remote** (`--remote-url` / `NANOCLAW_ONECLI_API_HOST`) — CLI only; no local gateway/Postgres.

---

## Agent knowledge store (`KNOWLEDGE_DATABASE_URL`)

Container MCP tools such as `knowledge_save` / `knowledge_search` / `knowledge_get` persist durable notes through the **gateway**, which stores them in **Postgres**.

| Fact | Detail |
|------|--------|
| **Required for knowledge tools** | Yes — a Postgres connection string must be configured |
| **Installed by `nanoclaw.sh`?** | **No** — setup does not provision a knowledge Postgres |
| **OneCLI’s Postgres** | Used only by the OneCLI vault (`onecli-postgres-1`). **Do not** point knowledge at it unless you intentionally share that DB (not recommended) |
| **Env var** | `KNOWLEDGE_DATABASE_URL` (preferred), or fallback `DATABASE_URL` |
| **Enable flag** | `KNOWLEDGE_ENABLED` — defaults to on when a URL is set; set `false` to force-disable |
| **Without a URL** | Knowledge store stays disabled; tools return a clear “disabled” error. Session SQLite (`inbound.db` / `outbound.db`) still works for chat |

**To enable knowledge:**

1. Run your own Postgres (any host/port; example in `.env.example` uses `127.0.0.1:5433` to avoid clashing with OneCLI on `5432`).
2. Set in `.env` on the **gateway** machine, e.g.  
   `KNOWLEDGE_DATABASE_URL=postgresql://nanoclaw:nanoclaw@127.0.0.1:5433/nanoclaw_knowledge`
3. Optionally init schema: `pnpm exec tsx scripts/init-knowledge-db.ts` (or rely on gateway `initKnowledgeSchema` at startup).
4. Restart gateway (and ensure worker can reach gateway for `knowledge_request` proxying).

Containers never talk to Postgres directly; the worker forwards knowledge ops to the gateway HTTP API.

---

## What setup does *not* install by default

These are **optional** — enable via skills, env, or separate packages when needed.

### Channels (skill-installed)

Trunk ships channel **infra**; adapters are added with `/add-<name>` skills, for example:

| Skill | Channel |
|-------|---------|
| `/add-discord`, `/add-slack`, `/add-telegram` | Chat apps |
| `/add-whatsapp`, `/add-whatsapp-cloud` | WhatsApp |
| `/add-teams`, `/add-gchat`, `/add-matrix`, `/add-signal` | Other messaging |
| `/add-github`, `/add-linear`, `/add-imessage`, `/add-webex` | Dev / platform |
| `/add-resend`, `/add-deltachat`, `/add-wechat`, `/add-emacs` | Email / niche |
| `/add-zoho-cliq` | Zoho Cliq (also used on this product tree) |

### Agent providers / tools

| Skill / flag | Purpose |
|--------------|---------|
| `/add-opencode`, `/add-ollama-provider`, `/add-codex` | Non-default agent backends |
| `/add-ollama-tool`, `/add-atomic-chat-tool` | Local model MCP tools |
| `/add-gmail-tool`, `/add-gcal-tool` | Google tools via OneCLI OAuth |
| `/add-vercel`, `/add-rtk`, `/add-parallel` | Deploy / token compression / etc. |
| `/add-mnemon`, `/add-karpathy-llm-wiki` | Memory / wiki |
| `/add-dashboard`, `/add-macos-statusbar` | Monitoring / macOS UI |
| `/claw` | CLI to talk to agent containers |

### Runtime / credential alternatives

| Skill / config | Purpose |
|----------------|---------|
| `/convert-to-apple-container` | macOS-native containers instead of Docker/Colima |
| `/use-native-credential-proxy` | `.env` credential proxy instead of OneCLI |
| `/init-onecli` | Standalone OneCLI install/migrate (if not done in setup) |
| `KNOWLEDGE_DATABASE_URL` | **Required for knowledge tools** — your Postgres URL; **not** installed by setup (see [Agent knowledge store](#agent-knowledge-store-knowledge_database_url)) |
| `LIVE_BROWSER_ENABLED=true` | Live browser streaming |
| `/manage-mounts` | Host directory allowlist for containers |

Operational skills (`/setup`, `/debug`, `/customize`, `/manage-channels`, `/update-nanoclaw`, …) guide workflows; they are not extra system packages unless a step installs something.

See also [product-tree.md](product-tree.md) for gateway/worker vs optional product surface.

---

## Related code

| Path | Role |
|------|------|
| `nanoclaw.sh` | Entry: preflight + bootstrap + `setup:auto` |
| `setup.sh` / `setup/install-node.sh` | Node + pnpm + deps |
| `setup/install-docker.sh` | OS-specific container runtime |
| `setup/container.ts` | Start runtime + build agent image |
| `setup/onecli.ts` | OneCLI gateway/CLI |
| `setup/auth.ts` | Credential registration |
| `setup/service.ts` / `setup/services/install.ts` | Gateway + worker OS services |
| `bin/nanoclaw` | Post-install lifecycle CLI |
