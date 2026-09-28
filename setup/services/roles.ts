/**
 * Which NanoClaw processes this machine should run.
 *
 * - both    — gateway + worker on one host (default / local dev)
 * - gateway — channels + HTTP API only; talk to a remote worker via GATEWAY_WORKER_URL
 * - worker  — containers only; callbacks use GATEWAY_PUBLIC_URL
 */
export type NanoclawRole = 'both' | 'gateway' | 'worker';

export function resolveRole(raw?: string): NanoclawRole {
  const v = (raw || process.env.NANOCLAW_ROLE || 'both').trim().toLowerCase();
  if (v === 'gateway' || v === 'worker' || v === 'both') return v;
  throw new Error(`Invalid NANOCLAW_ROLE="${raw ?? process.env.NANOCLAW_ROLE}". Use both|gateway|worker.`);
}

export function rolesToInstall(role: NanoclawRole): Array<'gateway' | 'worker'> {
  if (role === 'both') return ['gateway', 'worker'];
  return [role];
}
