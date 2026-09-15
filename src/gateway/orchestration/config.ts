/**
 * Multi-agent orchestration feature gate.
 * Env default is on; `gateway_settings.multi_agent_orchestration_enabled` overrides when set.
 */
import { MULTI_AGENT_ORCHESTRATION_ENABLED } from '../../config.js';
import { getGatewaySetting } from '../store/settings.js';

export const ORCHESTRATION_SETTING_KEY = 'multi_agent_orchestration_enabled';

export function isMultiAgentOrchestrationEnabled(): boolean {
  const setting = getGatewaySetting(ORCHESTRATION_SETTING_KEY);
  if (setting !== null) {
    const v = setting.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
    if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  }
  return MULTI_AGENT_ORCHESTRATION_ENABLED;
}
