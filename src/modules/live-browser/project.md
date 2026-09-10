## Live browser module

Option A: proxy `agent-browser` WebSocket stream (JPEG frames + mouse/keyboard input) through the Gateway so a logged-in user can watch and take over the agent's Chromium session.

Lives in `src/modules/live-browser/`. **Off by default.**

### Enable / disable

```bash
# .env
LIVE_BROWSER_ENABLED=true
# optional:
# LIVE_BROWSER_STREAM_PORT=9223
# LIVE_BROWSER_TICKET_TTL_MS=300000
```

Restart **worker** and **gateway** after changing the flag. New container spawns set `AGENT_BROWSER_STREAM_PORT` only when enabled, and prepend `container/skills/agent-browser/bin` on PATH so `agent-browser open` **auto-pins** the stream (LLMs often skip `stream enable`).

**Important:** agent-browser binds its stream to `127.0.0.1` inside the container (Docker `-p` cannot reach it). The worker uses `docker/podman exec` + a Node TCP relay to proxy the WebSocket. Containers started before enabling this flag must be respawned (send a new message).

To remove the module entirely: delete this directory, remove the import from `src/modules/index.ts`, and drop the thin guarded hooks in `container-runner.ts`, `worker/server.ts`, and `gateway/server.ts`.

### Flow

1. Container spawn (when enabled) sets `AGENT_BROWSER_STREAM_PORT`.
2. Agent uses `agent-browser open …`; the PATH wrapper auto-pins stream to
   `AGENT_BROWSER_STREAM_PORT` on container loopback (per session).
3. User opens **Live browser** in Agent Studio → Gateway ticket → WS via Gateway → Worker →
   `docker exec` relay → stream. Worker discovers **all** agent-browser sessions and prefers one
   with a real page URL (avoids white `about:blank` views from a blank default session).
4. **Take control** / **Release** write `live_browser_control` system messages into inbound DB.

### agent-browser 0.27 notes

- Each `--session` has its **own** stream port.
- `stream enable --port N` fails with “already enabled” unless you `stream disable` first.
- **Never `stream disable` from the live-browser PATH wrapper after `open`** — disable was
  observed to leave Chromium on `about:blank` (open prints the real URL, then clicks fail
  and Agent Studio goes white). Enable-only + paint flush instead.
- Auto-pin wrapper runs enable (if needed) + screenshot paint after every successful `open`.

### Security

- Stream never published on the host network.
- Gateway requires user session + agent ownership; WS uses a short-lived ticket.
- Worker endpoints require `WORKER_AUTH_TOKEN` when configured.

### Limits

- Live view only while the container is running and agent-browser has an active stream (after `open`).
- Human/agent races without Take control → Release handoff.
