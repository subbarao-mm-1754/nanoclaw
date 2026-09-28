import { getInstallSlug } from '../../src/install-slug.js';

export type ServiceKind = 'gateway' | 'worker';

/** launchd Label for a process. e.g. `com.nanoclaw-v2-ab12cd34.gateway` */
export function getLaunchdServiceLabel(
  kind: ServiceKind,
  projectRoot?: string,
): string {
  return `com.nanoclaw-v2-${getInstallSlug(projectRoot)}.${kind}`;
}

/** systemd unit basename (no .service). e.g. `nanoclaw-v2-ab12cd34-gateway` */
export function getSystemdServiceUnit(
  kind: ServiceKind,
  projectRoot?: string,
): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot)}-${kind}`;
}

/** systemd target that pulls gateway+worker when role=both */
export function getSystemdTargetUnit(projectRoot?: string): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** Relative dist entry for a process */
export function distEntry(kind: ServiceKind): string {
  return kind === 'gateway' ? 'dist/gateway/index.js' : 'dist/worker/index.js';
}

/** Log file basename (under logs/) */
export function logBasename(kind: ServiceKind, stream: 'out' | 'err'): string {
  if (stream === 'out') return `${kind}.log`;
  return `${kind}.error.log`;
}
