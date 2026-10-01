# Setup Wiring — Status & Remaining Work

> **Superseded for this product tree.** Runtime is gateway + worker — see
> [product-tree.md](product-tree.md) and [CLAUDE.md](../CLAUDE.md).
> Classic host files cited below (`src/index.ts`, `router.ts`, `delivery.ts`,
> `host-sweep.ts`, `data/v2.db`, `setup/register.ts`) were **removed**.

Last updated historically: 2026-04-09 (classic host era). Kept as historical
notes only; do not follow as current setup instructions.

---

## Historical notes (classic host — removed)

### Two-DB Split (session DB write isolation)
- Session DB split into `inbound.db` (host-owned) and `outbound.db` (container-owned)
- Still true on gateway+worker: worker/session-manager owns the same files
- Files today: `src/db/schema.ts` (`INBOUND_SCHEMA` + `OUTBOUND_SCHEMA`), `src/session-manager.ts`, `src/worker/`, `container/agent-runner/src/db/`

### OneCLI Integration
- Still true: `ensureAgent()` before `applyContainerConfig()` in `src/container-runner.ts`

### Channel barrel
- Today: `src/gateway/index.ts` imports `../channels/index.js` (not classic `src/index.ts`)

### Registration
- Today: gateway workspaces in `data/gateway.db` via Studio / `/build` — not classic `setup/register.ts` + `v2.db`
