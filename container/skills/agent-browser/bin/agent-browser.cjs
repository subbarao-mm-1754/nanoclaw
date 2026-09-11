/**
 * Live-browser helper around the real agent-browser CLI.
 *
 * ROOT CAUSES (from session logs):
 * 1) `stream disable` after `open` tore down the page → about:blank.
 * 2) OneCLI HTTP(S)_PROXY on agent-browser CLI calls also wipes the page to
 *    about:blank after a successful open (Live browser flashes then goes white).
 *    agent-browser talks to a local Chromium/CDP daemon — never send that
 *    traffic through the credential proxy.
 *
 * Permanent rules:
 * - ALWAYS clear HTTP(S)_PROXY for every real `agent-browser` invocation.
 * - NEVER `stream disable` after open/state-load bookkeeping.
 * - Only `stream enable --port` when not already enabled on that port.
 * - Force a paint (screenshot) so headless screencast is not black.
 * - After `state load`, if still about:blank, open the session origin once.
 *
 * Must stay .cjs — /app/package.json may set "type":"module".
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

function resolveRealBin() {
  const candidates = [
    process.env.AGENT_BROWSER_REAL_BIN,
    '/pnpm/agent-browser',
    '/pnpm/global/5/bin/agent-browser',
    '/usr/local/bin/agent-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return 'agent-browser';
}

const realBin = resolveRealBin();

/**
 * Strip OneCLI proxy for every CLI call. Leaving HTTP_PROXY set makes
 * open→get url land on about:blank (proxy intercepts local daemon traffic).
 */
function toolEnv() {
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1,localhost,::1']
    .filter(Boolean)
    .join(',');
  return {
    ...process.env,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    NODE_USE_ENV_PROXY: '0',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function run(binArgs, opts = {}) {
  return spawnSync(realBin, binArgs, {
    encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : 'inherit',
    // Always clear proxy — including the primary open/click/get commands.
    env: toolEnv(),
  });
}

function sessionPrefix(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session' && argv[i + 1]) {
      return ['--session', argv[i + 1]];
    }
    if (argv[i] === 'open' || argv[i] === 'state') break;
  }
  return [];
}

function commandName(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      i += 1;
      continue;
    }
    return argv[i] || '';
  }
  return '';
}

function isOpenCommand(argv) {
  return commandName(argv) === 'open';
}

function isStateLoadCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      i += 1;
      continue;
    }
    if (argv[i] === 'state' && argv[i + 1] === 'load') return true;
  }
  return false;
}

function stateLoadPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      i += 1;
      continue;
    }
    if (argv[i] === 'state' && argv[i + 1] === 'load' && argv[i + 2]) {
      return argv[i + 2];
    }
  }
  return null;
}

function isBlankUrl(url) {
  if (!url) return true;
  const u = String(url).trim();
  return (
    !u ||
    u === 'about:blank' ||
    u === 'chrome://newtab/' ||
    u.startsWith('chrome://') ||
    u.startsWith('chrome-error://')
  );
}

function extractUrl(out) {
  const text = String(out || '').trim();
  if (!text) return null;
  const m = text.match(/https?:\/\/\S+|about:[a-z0-9_-]+|chrome:\/\/\S+/i);
  if (m) return m[0];
  return text.split(/\s+/).pop() || null;
}

function currentUrl(prefix) {
  const r = run([...prefix, 'get', 'url'], { silent: true });
  return extractUrl(r.stdout || '');
}

function streamStatus(prefix) {
  const st = run([...prefix, 'stream', 'status', '--json'], {
    silent: true,
  });
  // stdout only — stderr may contain Undici proxy warnings
  const out = String(st.stdout || '').trim();
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return j && j.data ? j.data : j;
  } catch {
    return null;
  }
}

/**
 * Pin stream WITHOUT disable. `stream disable` was wiping the page to about:blank
 * (logs: open prints Desk URL, then clicks fail with Element not found on blank).
 */
function ensureStreamPinned(prefix) {
  const port = process.env.AGENT_BROWSER_STREAM_PORT;
  if (!port) return;

  const d = streamStatus(prefix);
  const already = d && d.enabled && Number(d.port) === Number(port);
  if (!already) {
    // Enable-only. Never disable here — that blanked the live page.
    run([...prefix, 'stream', 'enable', '--port', String(port)], {
      silent: true,
    });
  }
  run([...prefix, 'screenshot', '/tmp/.nanoclaw-live-paint.png'], {
    silent: true,
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveOriginForStateFile(stateFile) {
  if (!stateFile) return null;
  const abs = path.isAbsolute(stateFile)
    ? stateFile
    : path.resolve(process.cwd(), stateFile);
  const base = path.basename(abs, '.json');
  const indexCandidates = [
    path.join(path.dirname(abs), 'index.json'),
    '/workspace/agent/browser-sessions/index.json',
    path.join(process.cwd(), 'browser-sessions', 'index.json'),
  ];

  for (const indexPath of indexCandidates) {
    const index = readJson(indexPath);
    const sessions = index && Array.isArray(index.sessions) ? index.sessions : [];
    for (const row of sessions) {
      if (!row || typeof row !== 'object') continue;
      const file = String(row.file || '');
      const id = String(row.id || '');
      if (
        (id && id === base) ||
        file.endsWith(`${base}.json`) ||
        path.basename(file, '.json') === base
      ) {
        if (row.origin) return String(row.origin).replace(/\/$/, '');
      }
    }
  }

  const state = readJson(abs);
  const cookies = state && Array.isArray(state.cookies) ? state.cookies : [];
  const domains = cookies
    .map((c) => (c && c.domain ? String(c.domain) : ''))
    .filter(Boolean)
    .map((d) => (d.startsWith('.') ? d.slice(1) : d));
  domains.sort((a, b) => b.split('.').length - a.split('.').length || b.length - a.length);
  if (domains[0]) return `https://${domains[0]}`;
  return null;
}

function afterSuccessfulCommand() {
  const prefix = sessionPrefix(args);

  if (isStateLoadCommand(args)) {
    const origin = resolveOriginForStateFile(stateLoadPath(args));
    const url = currentUrl(prefix);
    if (origin && isBlankUrl(url)) {
      run([...prefix, 'open', origin], { silent: true });
    }
    ensureStreamPinned(prefix);
    return;
  }

  if (isOpenCommand(args)) {
    ensureStreamPinned(prefix);
  }
}

const primary = run(args);
const status = primary.status == null ? 1 : primary.status;
if (status === 0) {
  try {
    afterSuccessfulCommand();
  } catch {
    // Never fail the agent's command because of live-browser bookkeeping.
  }
}
process.exit(status);

module.exports = {
  isBlankUrl,
  extractUrl,
  resolveOriginForStateFile,
  isStateLoadCommand,
  isOpenCommand,
  stateLoadPath,
};
