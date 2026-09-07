/**
 * Headed Chromium capture on the gateway host for browser-session connect.
 * Uses playwright-core + a system Chrome/Chromium binary (no bundled download).
 */
import fs from 'fs';
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

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(input.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const live: LiveCapture = {
    sessionId: input.sessionId,
    browser,
    context,
    page,
    origin: input.origin,
    loginUrl: input.loginUrl,
    startedAt: Date.now(),
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
}
