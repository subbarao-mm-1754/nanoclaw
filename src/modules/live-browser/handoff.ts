import { spawn } from 'child_process';

import { writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { probeContainerLocalhostPort } from './container-relay.js';
import {
  getLiveBrowserBySession,
  getLiveBrowserByWorkspace,
  setControl,
  type LiveBrowserEndpoint,
} from './registry.js';

function assertSafeContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/** Agent containers run as USER node — CLI must use the same user or it talks to a different daemon. */
const AGENT_BROWSER_USER = 'node';

/** PATH inside agent image — `/pnpm/agent-browser` is the real binary entry. */
const AGENT_BROWSER_PATH =
  "/pnpm:/pnpm/global/5/bin:/usr/local/bin:/usr/bin:/bin";

function isBlankBrowserUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  return (
    url === 'about:blank' ||
    url === 'chrome://newtab/' ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-error://')
  );
}

export interface AgentBrowserStreamTarget {
  session: string;
  port: number;
  url: string | null;
  enabled: boolean;
  connected: boolean;
  current: boolean;
}

function execInAgentContainer(
  containerName: string,
  script: string,
  extraEnv: string[] = [],
): ReturnType<typeof spawn> {
  return spawn(
    CONTAINER_RUNTIME_BIN,
    [
      'exec',
      '-u',
      AGENT_BROWSER_USER,
      '-e',
      'HTTP_PROXY=',
      '-e',
      'HTTPS_PROXY=',
      '-e',
      'http_proxy=',
      '-e',
      'https_proxy=',
      '-e',
      'ALL_PROXY=',
      '-e',
      'all_proxy=',
      '-e',
      'NODE_USE_ENV_PROXY=0',
      '-e',
      `HOME=/home/${AGENT_BROWSER_USER}`,
      ...extraEnv,
      containerName,
      'node',
      '-e',
      script,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function runNodeInContainer(
  containerName: string,
  script: string,
  timeoutMs: number,
  extraEnv: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assertSafeContainerName(containerName);
  return new Promise((resolve) => {
    const child = execInAgentContainer(containerName, script, extraEnv);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Enumerate agent-browser sessions and their stream ports/URLs.
 * Each session has its own Chromium + stream port — connecting to a blank
 * default session while the agent works on another session yields a white view.
 */
export async function discoverAgentBrowserTargets(
  containerName: string,
  timeoutMs = 8000,
): Promise<AgentBrowserStreamTarget[]> {
  const script = `
const {spawnSync}=require('child_process');
const env={...process.env, PATH:'${AGENT_BROWSER_PATH}:'+(process.env.PATH||''), HOME:'/home/node'};
function run(args){
  const r=spawnSync('agent-browser',args,{encoding:'utf8',env,timeout:${Math.max(800, timeoutMs - 500)}});
  return {status:r.status, out:((r.stdout||'')+(r.stderr||'')).trim()};
}
function parseJson(out){
  const m=out.match(/\\{[\\s\\S]*\\}/);
  if(!m) return null;
  try{return JSON.parse(m[0]);}catch(e){return null;}
}
function extractUrl(out){
  if(!out) return null;
  const m=out.match(/https?:\\/\\/\\S+|about:[a-z0-9_-]+|chrome:\\/\\/\\S+/i);
  if(m) return m[0];
  const last=out.split(/\\s+/).pop();
  return last||null;
}
const list=parseJson(run(['session','list','--json']).out);
let names=(list&&list.data&&Array.isArray(list.data.sessions))?list.data.sessions:[];
const curOut=run(['session']).out;
const current=(curOut.split(/\\n/).pop()||'default').trim()||'default';
if(!names.length) names=[current||'default'];
if(!names.includes(current)) names.push(current);
const sessions=[];
for(const name of names){
  const st=parseJson(run(['--session',String(name),'stream','status','--json']).out);
  const d=st&&st.data?st.data:st;
  const port=d&&d.port!=null?Number(d.port):NaN;
  const urlOut=run(['--session',String(name),'get','url']);
  sessions.push({
    session:String(name),
    current:String(name)===current,
    port:Number.isInteger(port)&&port>0?port:null,
    enabled:!!(d&&d.enabled),
    connected:!!(d&&d.connected),
    url:urlOut.status===0?extractUrl(urlOut.out):null
  });
}
process.stdout.write(JSON.stringify({current,sessions}));
`;

  const { code, stdout, stderr } = await runNodeInContainer(containerName, script, timeoutMs);
  if (code !== 0 && !stdout.trim()) {
    log.debug('Live browser session discovery failed', {
      containerName,
      code,
      stderr: stderr.slice(0, 200),
    });
    return [];
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      sessions?: Array<{
        session?: string;
        current?: boolean;
        port?: number | null;
        enabled?: boolean;
        connected?: boolean;
        url?: string | null;
      }>;
    };
    const out: AgentBrowserStreamTarget[] = [];
    for (const row of parsed.sessions || []) {
      if (!row.session || row.port == null || !Number.isInteger(row.port) || row.port < 1) continue;
      out.push({
        session: row.session,
        port: row.port,
        url: row.url ?? null,
        enabled: Boolean(row.enabled),
        connected: Boolean(row.connected),
        current: Boolean(row.current),
      });
    }
    return out;
  } catch (err) {
    log.debug('Live browser session discovery parse failed', {
      containerName,
      err,
      stdout: stdout.slice(0, 200),
    });
    return [];
  }
}

/** Prefer a session that has a real page open; fall back to current / any enabled stream. */
export function pickBestBrowserTarget(
  targets: AgentBrowserStreamTarget[],
): AgentBrowserStreamTarget | null {
  if (!targets.length) return null;
  const enabled = targets.filter((t) => t.enabled && t.port > 0);
  const pool = enabled.length ? enabled : targets;
  const withPage = pool.filter((t) => !isBlankBrowserUrl(t.url));
  const ranked = (withPage.length ? withPage : pool).slice().sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (Boolean(a.connected) !== Boolean(b.connected)) return a.connected ? -1 : 1;
    return 0;
  });
  return ranked[0] ?? null;
}

/**
 * agent-browser (esp. older builds) may ignore AGENT_BROWSER_STREAM_PORT and
 * bind an OS-assigned port. Ask the *agent user's* daemon for the live port.
 */
export async function discoverAgentBrowserStreamPort(
  containerName: string,
  timeoutMs = 4000,
): Promise<number | null> {
  const best = pickBestBrowserTarget(await discoverAgentBrowserTargets(containerName, timeoutMs));
  return best?.port ?? null;
}

/** Current page URL from the agent-user daemon (source of truth vs stream url events). */
export async function discoverAgentBrowserPageUrl(
  containerName: string,
  timeoutMs = 4000,
  browserSession?: string | null,
): Promise<string | null> {
  const args = browserSession
    ? `['--session',${JSON.stringify(browserSession)},'get','url']`
    : `['get','url']`;
  const script = `
const {spawnSync}=require('child_process');
const env={...process.env, PATH:'${AGENT_BROWSER_PATH}:'+(process.env.PATH||''), HOME:'/home/node'};
const r=spawnSync('agent-browser',${args},{encoding:'utf8',env,timeout:${Math.max(500, timeoutMs - 200)}});
const out=((r.stdout||'')+(r.stderr||'')).trim();
if(r.status!==0||!out){process.stderr.write(out.slice(0,300));process.exit(2);}
const m=out.match(/https?:\\/\\/\\S+|about:[a-z0-9_-]+|chrome:\\/\\/\\S+/i);
process.stdout.write(m?m[0]:out.split(/\\s+/).pop());
`;

  const { code, stdout } = await runNodeInContainer(containerName, script, timeoutMs);
  const url = stdout.trim();
  return code === 0 && url ? url : null;
}

/**
 * Sync endpoint port/session to the agent-user daemon.
 * Prefer a session with a real page over a blank default stream (white screen).
 *
 * Do NOT force-rebind the stream port on every probe — `stream disable` would
 * drop an active Agent Studio WebSocket. Discovery alone is enough to follow
 * OS-assigned ports; the PATH wrapper pins after `open`.
 *
 * Do NOT create a blank default stream when nothing is browsing yet.
 * stream_ready means the screencast port is listening — Studio shows whatever
 * page is currently open (blank overlay if about:blank).
 */
export async function probeStreamPort(ep: LiveBrowserEndpoint): Promise<boolean> {
  const targets = await discoverAgentBrowserTargets(ep.containerName);
  const best = pickBestBrowserTarget(targets);

  if (!best) return false;

  if (best.port !== ep.containerPort || best.session !== ep.browserSession) {
    log.info('Live browser stream target updated', {
      containerName: ep.containerName,
      fromPort: ep.containerPort,
      toPort: best.port,
      browserSession: best.session,
      pageUrl: best.url,
    });
  }
  ep.containerPort = best.port;
  ep.browserSession = best.session;
  ep.pageUrl = best.url;

  return probeContainerLocalhostPort(ep.containerName, ep.containerPort);
}

/**
 * Headless Chromium often emits black screencast frames until something forces a
 * compositor paint. A cheap screenshot does that without changing the page.
 */
export async function forceLiveBrowserPaint(
  containerName: string,
  browserSession?: string | null,
): Promise<void> {
  const sessionArgs = browserSession
    ? `['--session',${JSON.stringify(browserSession)},`
    : '[';
  const script = `
const {spawnSync}=require('child_process');
const env={...process.env, PATH:'${AGENT_BROWSER_PATH}:'+(process.env.PATH||''), HOME:'/home/node'};
const args=${sessionArgs}'screenshot','/tmp/.nanoclaw-live-paint.png'];
spawnSync('agent-browser',args,{encoding:'utf8',env,timeout:8000});
process.exit(0);
`;
  await runNodeInContainer(containerName, script, 9000);
}

export async function publicEndpointStatus(ep: LiveBrowserEndpoint, streamReady: boolean) {
  // Always re-read the live URL when the stream is up. Caching about:blank from
  // mid-redirect (Desk → marketing → dashboard) made Agent Studio stick on a
  // white screen even after the real page loaded.
  let pageUrl: string | null = ep.pageUrl ?? null;
  if (streamReady) {
    const live = await discoverAgentBrowserPageUrl(ep.containerName, 4000, ep.browserSession);
    if (live) {
      pageUrl = live;
      ep.pageUrl = live;
    } else if (ep.pageUrl && !isBlankBrowserUrl(ep.pageUrl)) {
      pageUrl = ep.pageUrl;
    }
  }
  const blank = isBlankBrowserUrl(pageUrl);
  return {
    enabled: true,
    available: true,
    session_id: ep.sessionId,
    workspace_id: ep.workspaceId,
    agent_group_id: ep.agentGroupId,
    container_name: ep.containerName,
    container_port: ep.containerPort,
    browser_session: ep.browserSession ?? null,
    control: ep.control,
    stream_ready: streamReady,
    page_url: pageUrl,
    registered_at: new Date(ep.registeredAt).toISOString(),
    hint: streamReady
      ? blank
        ? 'Stream is up, but the selected agent-browser session is still about:blank. Ask the agent to open the site you want (and keep that same browser session open), then Reconnect.'
        : undefined
      : blank
        ? 'Chromium is on a blank page. Ask the agent to open the site (state load → open URL). Live view will connect once a real page is open.'
        : 'Container is running but agent-browser stream is not ready yet. Ask the agent to open a page (agent-browser open …), then Reconnect.',
  };
}

export async function takeControl(workspaceId: string): Promise<LiveBrowserEndpoint> {
  const ep = getLiveBrowserByWorkspace(workspaceId);
  if (!ep) throw new LiveBrowserError('No live browser for this agent (is the container running?)', 404);
  setControl(ep.sessionId, 'human');
  try {
    writeHandoff(ep, 'human');
  } catch (err) {
    // Still grant control for the live view even if the inbound handoff write fails.
    log.warn('Live browser take-control handoff write failed', {
      workspaceId,
      sessionId: ep.sessionId,
      err,
    });
  }
  log.info('Live browser take control', { workspaceId, sessionId: ep.sessionId });
  return ep;
}

export async function releaseControl(workspaceId: string): Promise<LiveBrowserEndpoint> {
  const ep = getLiveBrowserByWorkspace(workspaceId);
  if (!ep) throw new LiveBrowserError('No live browser for this agent', 404);
  setControl(ep.sessionId, 'agent');
  try {
    writeHandoff(ep, 'agent');
  } catch (err) {
    log.warn('Live browser release-control handoff write failed', {
      workspaceId,
      sessionId: ep.sessionId,
      err,
    });
  }
  log.info('Live browser release control', { workspaceId, sessionId: ep.sessionId });
  return ep;
}

function writeHandoff(ep: LiveBrowserEndpoint, state: 'human' | 'agent'): void {
  const text =
    state === 'human'
      ? 'Human has taken control of the live browser. Do NOT run agent-browser commands until you receive a live_browser_control message with state "agent". Wait silently.'
      : 'Human released live browser control. Run agent-browser snapshot -i on the current page and continue the user task from there. Do not reopen login unless the page shows logged-out.';

  writeSessionMessage(ep.agentGroupId, ep.sessionId, {
    id: `live-browser-${state}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({
      type: 'live_browser_control',
      state,
      text,
    }),
  });
}

export class LiveBrowserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'LiveBrowserError';
  }
}

export function resolveEndpoint(opts: {
  workspaceId?: string;
  sessionId?: string;
}): LiveBrowserEndpoint | undefined {
  if (opts.workspaceId) return getLiveBrowserByWorkspace(opts.workspaceId);
  if (opts.sessionId) return getLiveBrowserBySession(opts.sessionId);
  return undefined;
}
