/**
 * Global agent runtime defaults (not per-workspace / per-agent).
 * Change the model here (or set AGENT_MODEL in `.env` to override).
 * ANTHROPIC_BASE_URL / NO_PROXY stay in `.env` and are applied via providers/claude.ts.
 */
//export const GLOBAL_AGENT_MODEL = 'gemma4:12b-mxfp8';
//export const GLOBAL_AGENT_MODEL = '';
export const GLOBAL_AGENT_MODEL = 'qwen3.6:35b-a3b-mlx-bf16';
