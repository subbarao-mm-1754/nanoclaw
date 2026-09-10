/**
 * Live browser module — enable with LIVE_BROWSER_ENABLED=true.
 *
 * Proxies agent-browser WebSocket streams via Gateway for pair-browsing.
 * See project.md.
 */
import { LIVE_BROWSER_ENABLED } from '../../config.js';

export { LIVE_BROWSER_ENABLED };

export function isLiveBrowserEnabled(): boolean {
  return LIVE_BROWSER_ENABLED;
}

export {
  applyLiveBrowserContainerArgs,
  registerLiveBrowserEndpoint,
  unregisterLiveBrowserEndpoint,
  type LiveBrowserSpawnMeta,
} from './container-hooks.js';

export {
  getLiveBrowserByWorkspace,
  getLiveBrowserBySession,
  listLiveBrowserEndpoints,
  type LiveBrowserEndpoint,
} from './registry.js';

export {
  handleWorkerLiveBrowserHttp,
  handleWorkerLiveBrowserUpgrade,
} from './worker-routes.js';

export {
  handleGatewayLiveBrowserHttp,
  handleGatewayLiveBrowserUpgrade,
} from './gateway-routes.js';
