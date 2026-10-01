/**
 * Dashboard pusher — classic host only (not supported).
 *
 * This skill resource still assumed `data/v2.db` + removed modules
 * (`src/db/agent-groups`, `src/db/connection`, etc.). On the gateway+worker
 * product it must be rewritten against `gateway.db` / gateway HTTP APIs
 * before use. See docs/product-tree.md.
 */
export function startDashboardPusher(): never {
  throw new Error(
    'dashboard-pusher is classic-host only; rewrite against gateway APIs before use',
  );
}

export function stopDashboardPusher(): void {}
