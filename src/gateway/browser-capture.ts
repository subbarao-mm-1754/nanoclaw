/**
 * Headed Chromium capture on the gateway host for browser-session connect.
 * Uses playwright-core + a system Chrome/Chromium binary (no bundled download).
 *
 * WSL note: launching Windows Chrome.exe via Playwright's default pipe transport
 * fails with "Remote debugging pipe file descriptors are not open". On WSL we
 * start Chrome with --remote-debugging-port and connectOverCDP instead.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

export interface LiveCapture {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  origin: string;
  loginUrl: string;
  startedAt: number;
  /** Present when Chrome was started as a child (WSL → Windows Chrome CDP). */
  child?: ChildProcess;
}

const liveBySession = new Map<string, LiveCapture>();
const liveByToken = new Map<string, string>(); // token → sessionId

const envChrome = readEnvFile([
  'CHROME_PATH',
  'GOOGLE_CHROME_BIN',
  'AGENT_BROWSER_EXECUTABLE_PATH',
]);

function candidateChromePaths(): string[] {
  const fromEnv = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    envChrome.CHROME_PATH,
    envChrome.GOOGLE_CHROME_BIN,
    envChrome.AGENT_BROWSER_EXECUTABLE_PATH,
  ].filter((p): p is string => Boolean(p && p.trim()));

  const platform = process.platform;
  if (platform === 'win32') {
    return [
      ...fromEnv,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      ...fromEnv,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  return [
    ...fromEnv,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ];
}

export function resolveChromeExecutable(): string {
  for (const p of candidateChromePaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  throw new Error(
    'No Chrome/Chromium found for headed login. Install one (e.g. sudo apt-get install -y chromium-browser) ' +
      'or set CHROME_PATH in .env to the browser executable.',
  );
}

/** True when running under WSL (gateway on Linux, display/Chrome often on Windows). */
export function isWslHost(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/** Windows Chrome path reached from WSL (/mnt/c/.../chrome.exe). */
export function isWindowsChromeFromWsl(executablePath: string): boolean {
  if (process.platform !== 'linux') return false;
  const normalized = executablePath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.exe') || normalized.startsWith('/mnt/c/');
}

/** Ensure headed Chromium can find WSLg (gateway services often lack DISPLAY). */
function ensureWslDisplay(): void {
  if (!isWslHost()) return;
  if (process.env.DISPLAY?.trim()) return;
  try {
    if (fs.existsSync('/tmp/.X11-unix/X0')) {
      process.env.DISPLAY = ':0';
      log.info('WSL headed browser: set DISPLAY=:0 for WSLg');
    }
  } catch {
    // ignore
  }
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not allocate a TCP port for Chrome CDP'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(
    `Chrome CDP did not become ready on 127.0.0.1:${port}` +
      (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
  );
}

/**
 * Launch Windows Chrome from WSL via CDP (avoids Playwright pipe FD failure).
 */
async function launchWindowsChromeViaCdp(
  executablePath: string,
  loginUrl: string,
): Promise<{ browser: Browser; context: BrowserContext; page: Page; child: ChildProcess }> {
  const port = await freeTcpPort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    loginUrl,
  ];

  log.info('WSL→Windows Chrome: launching via CDP', { executablePath, port });
  const child = spawn(executablePath, args, {
    stdio: 'ignore',
    detached: false,
    windowsHide: false,
  });

  child.on('error', (err) => {
    log.warn('Windows Chrome child process error', { err });
  });

  try {
    await waitForCdp(port, 20_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    if (page.url() === 'about:blank' || page.url() === '') {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    return { browser, context, page, child };
  } catch (err) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

export function getLiveCapture(sessionId: string): LiveCapture | undefined {
  return liveBySession.get(sessionId);
}

export function getLiveCaptureByToken(token: string): LiveCapture | undefined {
  const sessionId = liveByToken.get(token);
  return sessionId ? liveBySession.get(sessionId) : undefined;
}

export async function openHeadedLogin(input: {
  sessionId: string;
  connectToken: string;
  origin: string;
  loginUrl: string;
}): Promise<LiveCapture> {
  await closeLiveCapture(input.sessionId);

  const executablePath = resolveChromeExecutable();
  log.info('Opening headed browser for session connect', {
    sessionId: input.sessionId,
    origin: input.origin,
    executablePath,
  });

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let child: ChildProcess | undefined;

  if (isWindowsChromeFromWsl(executablePath)) {
    const launched = await launchWindowsChromeViaCdp(executablePath, input.loginUrl);
    browser = launched.browser;
    context = launched.context;
    page = launched.page;
    child = launched.child;
  } else {
    ensureWslDisplay();
    log.info('Launching Linux Chromium for headed login', {
      executablePath,
      display: process.env.DISPLAY ?? '(unset)',
    });
    browser = await chromium.launch({
      executablePath,
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      env: {
        ...process.env,
        // Gateway systemd units often omit DISPLAY; WSLg needs this.
        ...(process.env.DISPLAY ? {} : { DISPLAY: ':0' }),
      },
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    await page.goto(input.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  const live: LiveCapture = {
    sessionId: input.sessionId,
    browser,
    context,
    page,
    origin: input.origin,
    loginUrl: input.loginUrl,
    startedAt: Date.now(),
    child,
  };
  liveBySession.set(input.sessionId, live);
  liveByToken.set(input.connectToken, input.sessionId);

  browser.on('disconnected', () => {
    liveBySession.delete(input.sessionId);
    liveByToken.delete(input.connectToken);
  });

  return live;
}

export async function readStorageState(sessionId: string): Promise<unknown> {
  const live = liveBySession.get(sessionId);
  if (!live) throw new Error('No live browser capture for this session');
  return live.context.storageState();
}

export async function closeLiveCapture(sessionId: string): Promise<void> {
  const live = liveBySession.get(sessionId);
  if (!live) return;
  liveBySession.delete(sessionId);
  for (const [token, id] of liveByToken) {
    if (id === sessionId) liveByToken.delete(token);
  }
  try {
    await live.browser.close();
  } catch (err) {
    log.warn('Failed closing headed capture browser', { sessionId, err });
  }
  if (live.child && !live.child.killed) {
    try {
      live.child.kill('SIGTERM');
    } catch (err) {
      log.warn('Failed killing Chrome child process', { sessionId, err });
    }
  }
}
