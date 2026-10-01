---
name: init-first-agent
description: Bootstrap the first agent on the gateway+worker product. Classic host init-first-agent (data/v2.db / scripts/init-first-agent.ts) was removed.
---

# Init First Agent — gateway + worker

The classic `/init-first-agent` flow (`scripts/init-first-agent.ts`, central `data/v2.db`, host `ncl`) is **not part of this product**.

## What to do instead

1. Ensure services are running: `./bin/zclaw status` (or `./bin/zclaw start`).
2. Open **Agent Studio** / chat UI if enabled (`CHATBOT_UI_ENABLED=true`), **or** use your wired channel (e.g. Zoho Cliq).
3. Create an agent with `/build …` then `/use <name>` (or Studio **Your agents**).
4. For multi-agent teams, keep `MULTI_AGENT_ORCHESTRATION_ENABLED=true` (default) and follow [docs/product-tree.md](../../docs/product-tree.md) + `src/gateway/orchestration/project.md`.

## Channel prerequisites

- Channel adapter installed (`/add-zoho-cliq` or other `/add-<channel>`).
- Credentials in `.env` / OneCLI as required by the channel skill.
- Gateway logs show the adapter connected.

If the user expected the old DM-wire script path, explain it was removed with the classic host and walk them through `/build` + `/use` instead.
