/**
 * Setup driver for the gateway + worker product (`pnpm run setup:auto`).
 *
 * Steps: environment → container → onecli → auth → mounts → service →
 * timezone → verify. Classic host CLI-agent / channel wiring removed —
 * configure Zoho Cliq (or other channels) via gateway env / API after install.
 *
 * Config via env:
 *   NANOCLAW_SKIP  comma-separated steps to skip
 *                  (environment|container|onecli|auth|mounts|service|timezone|verify)
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import * as os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from './lib/bright-select.js';
import { offerClaudeOnFailure } from './lib/claude-handoff.js';
import {
  applyToEnv,
  parseFlags,
  printHelp,
  readFromEnv,
} from './lib/setup-config-parse.js';
import { runAdvancedScreen } from './lib/setup-config-screen.js';
import { runWindowedStep } from './lib/windowed-runner.js';
import { pollHealth } from './onecli.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { claudeCliAvailable, resolveTimezoneViaClaude } from './lib/tz-from-claude.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietChild, runQuietStep } from './lib/runner.js';
import { emit as phEmit } from './lib/diagnostics.js';
import { brandBody, brandBold, dimWrap, fitToWidth, fmtDuration, note, wrapForGutter } from './lib/theme.js';
import { isValidTimezone } from '../src/timezone.js';

const RUN_START = Date.now();

async function main(): Promise<void> {
  // Make sure ~/.local/bin is on PATH for every child process we spawn.
  // Installers we run mid-setup (OneCLI, claude) drop binaries there and
  // append a PATH line to the user's shell rc, but rc updates don't reach
  // an already-running Node process — so without this patch a freshly
  // installed `onecli` is invisible to a subsequent `runInheritScript`.
  ensureLocalBinOnPath();

  // Parse CLI flags first — `--help` short-circuits before we render anything,
  // and flag values get folded into process.env so existing step code reading
  // NANOCLAW_* sees them unchanged.
  const flagResult = parseFlags(process.argv.slice(2));
  if (flagResult.help) {
    printHelp();
    process.exit(0);
  }
  if (flagResult.errors.length > 0) {
    for (const err of flagResult.errors) console.error(`error: ${err}`);
    console.error('');
    console.error('Run with --help for the full list of supported flags.');
    process.exit(1);
  }
  let configValues = { ...readFromEnv(), ...flagResult.values };
  applyToEnv(configValues);

  printIntro();
  initProgressionLog();
  phEmit('auto_started');

  // Welcome menu — default path or open advanced overrides before any setup
  // work begins. Default lands on standard so Enter is the happy path.
  // On sg re-exec, the user already chose — skip straight to standard.
  let startChoice: 'default' | 'advanced' = 'default';
  if (process.env.NANOCLAW_REEXEC_SG !== '1') {
    startChoice = ensureAnswer(
      await brightSelect<'default' | 'advanced'>({
        message: 'How would you like to begin?',
        options: [
          { value: 'default', label: 'Standard setup' },
          { value: 'advanced', label: 'Advanced', hint: 'override defaults' },
        ],
        initialValue: 'default',
      }),
    ) as 'default' | 'advanced';
    setupLog.userInput('start_choice', startChoice);
  }
  if (startChoice === 'advanced') {
    configValues = await runAdvancedScreen(configValues);
    applyToEnv(configValues);
  }

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking your system…',
      done: 'Your system looks good.',
    });
    if (!res.ok) {
      await fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
      );
    }
  }

  if (!skip.has('container')) {
    p.log.message(brandBody(dimWrap('Your assistant lives in its own sandbox. It can only see what you explicitly share.', 4)));
    p.log.message(
      brandBody(
        dimWrap(
          'The first build pulls a base image and installs a few tools. On a fresh machine this usually takes 3–10 minutes.',
          4,
        ),
      ),
    );
    const res = await runWindowedStep('container', {
      running: "Preparing your assistant's sandbox…",
      done: 'Sandbox ready.',
      failed: "Couldn't prepare the sandbox.",
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        await fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        await fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      await fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    p.log.message(
      brandBody(
        dimWrap(
          'Your assistant never gets your API keys directly. The vault adds them to approved requests as they leave the sandbox.',
          4,
        ),
      ),
    );

    const remoteHost = process.env.NANOCLAW_ONECLI_API_HOST?.trim();

    if (remoteHost) {
      // Advanced-settings override: user has already named a remote vault,
      // so skip the local-vs-fresh prompt entirely. Health-check it here
      // rather than letting the step fail silently — a typo in the URL is a
      // common mistake and the answer is human-fixable.
      const s = p.spinner();
      s.start(`Checking remote OneCLI at ${remoteHost}…`);
      const healthy = await pollHealth(remoteHost, 5000);
      if (!healthy) {
        s.stop(`Couldn't reach OneCLI at ${remoteHost}.`, 1);
        await fail(
          'onecli',
          `Couldn't reach OneCLI at ${remoteHost}.`,
          'Check the URL and that OneCLI is running on the remote machine, then retry.',
        );
      }
      s.stop('Remote OneCLI is reachable.');

      const res = await runQuietStep(
        'onecli',
        {
          running: `Connecting to remote OneCLI at ${remoteHost}…`,
          done: 'OneCLI vault ready.',
        },
        ['--remote-url', remoteHost],
      );
      if (!res.ok) {
        const err = res.terminal?.fields.ERROR;
        await fail(
          'onecli',
          `Couldn't connect to remote OneCLI (${err ?? 'unknown error'}).`,
          'Check the URL and that OneCLI is running on the remote machine, then retry.',
        );
      }
    } else {
      // Respect an existing OneCLI install. Re-running the installer would
      // rebind the listener and knock any other app using that gateway
      // offline — confirm with the user before doing that.
      const existing = detectExistingOnecli();
      let reuse = false;
      if (existing) {
        const choice = ensureAnswer(
          await brightSelect({
            message: `Found an existing OneCLI at ${existing.apiHost}. What would you like to do?`,
            options: [
              {
                value: 'reuse',
                label: 'Use the existing instance',
                hint: 'recommended — keeps other apps bound to this vault working',
              },
              {
                value: 'fresh',
                label: 'Install a fresh instance for NanoClaw',
                hint: 'reinstalls onecli; other apps may need to reconnect',
              },
            ],
          }),
        ) as 'reuse' | 'fresh';
        setupLog.userInput('onecli_choice', choice);
        reuse = choice === 'reuse';
      }

      const res = await runQuietStep(
        'onecli',
        {
          running: reuse
            ? 'Hooking up to your existing OneCLI…'
            : "Setting up OneCLI, your agent's vault…",
          done: 'OneCLI vault ready.',
        },
        reuse ? ['--reuse'] : [],
      );
      if (!res.ok) {
        const err = res.terminal?.fields.ERROR;
        if (err === 'onecli_not_on_path_after_install') {
          await fail(
            'onecli',
            'OneCLI was installed but your shell needs to refresh to see it.',
            'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
          );
        }
        await fail(
          'onecli',
          `Couldn't set up OneCLI (${err ?? 'unknown error'}).`,
          'Make sure curl is installed and ~/.local/bin is writable, then retry.',
        );
      }
    }
  }

  if (!skip.has('auth')) {
    await runAuthStep();
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
    );
    if (!res.ok) {
      await fail('mounts', "Couldn't write access rules.");
    }
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Starting NanoClaw in the background…',
      done: 'NanoClaw is running.',
    });
    if (!res.ok) {
      await fail('service', "Couldn't start NanoClaw.", 'See logs/nanoclaw.error.log for details.');
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn(brandBody("NanoClaw's permissions need a tweak before it can reach Docker."));
      p.log.message(
        brandBody(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' + `  systemctl --user restart ${getSystemdUnit()}`,
        ),
      );
    }
  }

  if (!skip.has('timezone')) {
    await runTimezoneStep();
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Making sure everything works together…',
      done: "Everything's connected.",
      failed: 'A few things still need your attention.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push("• Your Claude account isn't connected. Re-run setup and try again.");
      }
      const service = res.terminal?.fields.SERVICE;
      if (service === 'running_other_checkout') {
        const label = getLaunchdLabel();
        notes.push(
          wrapForGutter(
            [
              '• Your NanoClaw service is running from a different folder on this machine.',
              '  Point it at this checkout with:',
              `    launchctl bootout gui/$(id -u)/${label}`,
              `    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
            ].join('\n'),
            6,
          ),
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push(
          '• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.',
        );
      }
      if (notes.length > 0) {
        note(notes.join('\n'), "What's left");
      }
      // "What's left" is a soft failure — we don't abort like fail(), but the
      // user is still stuck and a fix is exactly what claude-assist is for.
      const summary = notes
        .map((n) => n.replace(/^•\s*/, '').split('\n')[0].trim())
        .filter(Boolean)
        .join(' · ');
      phEmit('setup_incomplete', {
        unresolved_count: notes.length,
        service_running: res.terminal?.fields.SERVICE === 'running',
        has_credentials: res.terminal?.fields.CREDENTIALS === 'configured',
      });
      await offerClaudeOnFailure({
        stepName: 'verify',
        msg: summary || 'Verification completed with unresolved issues.',
        hint: `Terminal block: ${JSON.stringify(res.terminal?.fields ?? {})}`,
        rawLogPath: res.rawLog,
      });
      p.outro(k.yellow('Almost there. A few things still need your attention.'));
      return;
    }
  }

  const rows: [string, string][] = [
    ['Check services:', './bin/nanoclaw status'],
    ['Follow logs:', './bin/nanoclaw logs -f'],
    ['Gateway log:', 'tail -f logs/gateway.log'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows.map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`).join('\n');
  note(nextSteps, 'Try these');

  note(
    wrapForGutter(
      'NanoClaw gateway and worker run as separate services on this machine (or split hosts later). Keep this computer on, or deploy to always-on VMs.',
      6,
    ),
    'Heads up',
  );

  setupLog.complete(Date.now() - RUN_START);
  phEmit('setup_completed', { duration_ms: Date.now() - RUN_START });
  p.outro(k.green("You're ready — gateway and worker are installed."));
}

// ─── auth step (select → branch) ────────────────────────────────────────

async function runAuthStep(): Promise<void> {
  if (anthropicSecretExists()) {
    p.log.success(brandBody('Your Claude account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  // Custom Anthropic-compatible endpoint flow. Both URL and token must be set;
  // OneCLI stores the token as a generic Bearer secret keyed to the URL host,
  // so the container only ever sees ANTHROPIC_BASE_URL + a placeholder.
  const customBaseUrl = process.env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const customAuthToken = process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (customBaseUrl && customAuthToken) {
    await runCustomEndpointAuth(customBaseUrl, customAuthToken);
    return;
  }

  const method = ensureAnswer(
    await brightSelect({
      message: 'How would you like to connect to Claude?',
      options: [
        {
          value: 'subscription',
          label: 'Sign in with my Claude subscription',
          hint: 'recommended if you have Pro or Max',
        },
        {
          value: 'oauth',
          label: 'Paste an OAuth token I already have',
          hint: 'sk-ant-oat…',
        },
        {
          value: 'api',
          label: 'Paste an Anthropic API key',
          hint: 'pay-per-use via console.anthropic.com',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'not recommended — Claude helps debug setup issues',
        },
      ],
    }),
  ) as 'subscription' | 'oauth' | 'api' | 'skip';
  setupLog.userInput('auth_method', method);
  phEmit('auth_method_chosen', { method });

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message:
          "Skip Claude sign-in? The agent won't be able to run until you connect, and we won't be able to help debug setup errors.",
        initialValue: false,
      }),
    );
    if (!confirmed) {
      // Loop back to the auth picker so they can choose a real method.
      return runAuthStep();
    }
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped' });
    p.log.warn(
      brandBody(
        'Claude sign-in skipped. Re-run setup or run `bash nanoclaw.sh` to finish later.',
      ),
    );
    return;
  }

  if (method === 'subscription') {
    await runSubscriptionAuth();
  } else {
    await runPasteAuth(method);
  }
}

async function runSubscriptionAuth(): Promise<void> {
  p.log.step(brandBody('Opening the Claude sign-in flow…'));
  console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  console.log();
  const start = Date.now();
  const code = await runInheritScript('bash', ['setup/register-claude-token.sh']);
  const durationMs = Date.now() - start;
  console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    await fail(
      'auth',
      "Couldn't complete the Claude sign-in.",
      'Re-run setup and try again, or choose a paste option instead.',
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  p.log.success(brandBody('Claude account connected.'));
}

async function runPasteAuth(method: 'oauth' | 'api'): Promise<void> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';

  const answer = ensureAnswer(
    await p.password({
      message: `Paste your ${label}`,
      clearOnError: true,
      validate: (v) => {
        // Strip any internal whitespace so a line-wrapped paste that did
        // survive into clack can still validate. The mid-token-newline
        // case where clack only sees the first line is caught by the
        // shape check below.
        const cleaned = (v ?? '').replace(/\s+/g, '');
        if (!cleaned) return 'Required';
        if (!cleaned.startsWith(prefix)) {
          return `Should start with ${prefix}…`;
        }
        if (method === 'oauth' && !/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/.test(cleaned)) {
          return cleaned.length < 90
            ? 'Token looks truncated — line breaks in the paste can cut it off. Widen your terminal so the token fits on one line, then paste again.'
            : "Token shape doesn't look right (expected sk-ant-oat…AA).";
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).replace(/\s+/g, '');

  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'anthropic',
      '--value',
      token,
      '--host-pattern',
      'api.anthropic.com',
    ],
    {
      running: `Saving your ${label} to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    {
      extraFields: { METHOD: method },
    },
  );
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }
}

/**
 * Set up Anthropic auth for a custom endpoint. The token is stored as a
 * OneCLI generic secret with header injection so the proxy rewrites the
 * Authorization header on the wire — the container only ever sees
 * ANTHROPIC_BASE_URL + a placeholder bearer.
 */
async function runCustomEndpointAuth(
  baseUrl: string,
  token: string,
): Promise<void> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    await fail(
      'auth',
      `Invalid Anthropic base URL: ${baseUrl}`,
      'Check --anthropic-base-url and retry.',
    );
    return;
  }

  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'generic',
      '--value',
      token,
      '--host-pattern',
      host,
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    ],
    {
      running: `Saving your Anthropic auth token to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    { extraFields: { METHOD: 'custom-endpoint', HOST: host } },
  );
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your Anthropic auth token to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }

  // ANTHROPIC_BASE_URL has to be in .env so the runtime provider config
  // reads it when building container env. The token is *not* written —
  // OneCLI holds it.
  writeEnvLine('ANTHROPIC_BASE_URL', baseUrl);

  // Register the claude provider so the runtime passes ANTHROPIC_BASE_URL
  // and the placeholder bearer into the container. Only appended when the
  // user has configured a custom endpoint; standard installs don't load
  // the file at all.
  appendProviderImport('./claude.js');
}

function writeEnvLine(key: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(envFile, next);
}

function appendProviderImport(modulePath: string): void {
  const file = path.join(process.cwd(), 'src', 'providers', 'index.ts');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const line = `import '${modulePath}';`;
  if (content.includes(line)) return;
  const sep = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, content + sep + line + '\n');
}

// ─── timezone step ─────────────────────────────────────────────────────

/**
 * Auto-detect TZ, confirm with the user when it comes back as UTC (a
 * common sign we're on a VPS that wasn't localised), and persist through
 * the usual `--step timezone -- --tz <zone>` path. Free-text answers get
 * a headless `claude -p` pass to resolve them to a real IANA zone.
 */
async function runTimezoneStep(): Promise<void> {
  const res = await runQuietStep('timezone', {
    running: 'Checking your timezone…',
    done: 'Timezone set.',
  });
  if (!res.ok && res.terminal?.fields.NEEDS_USER_INPUT !== 'true') {
    await fail('timezone', "Couldn't determine your timezone.");
  }

  const fields = res.terminal?.fields ?? {};
  const resolvedTz = fields.RESOLVED_TZ;
  const needsInput = fields.NEEDS_USER_INPUT === 'true';
  const isUtc = resolvedTz === 'UTC' || resolvedTz === 'Etc/UTC' || resolvedTz === 'Universal';

  // Three branches:
  //   - no TZ detected: ask where they are (or leave as UTC)
  //   - detected UTC: confirm (likely VPS, but worth checking)
  //   - detected specific zone: confirm explicitly rather than silently
  //     persisting — users shouldn't be surprised the agent "already knew"
  //     their timezone from system settings they didn't think about.
  if (!needsInput && !isUtc && resolvedTz && resolvedTz !== 'none') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: `I detected ${resolvedTz} from your computer settings. Is that right?`,
        initialValue: true,
      }),
    );
    setupLog.userInput('timezone_confirm_detected', String(confirmed));
    if (confirmed) return;
  }

  const message = needsInput
    ? "Your system didn't expose a timezone. Which one are you in?"
    : !isUtc
      ? 'Where are you, then?'
      : 'Your system reports UTC as the timezone. Is that right, or are you somewhere else?';

  // For the non-UTC "detected-but-wrong" branch we skip the select and jump
  // straight to the free-text prompt — the user already said "not that".
  let choice: 'keep' | 'answer' = 'answer';
  if (needsInput || isUtc) {
    choice = ensureAnswer(
      await brightSelect({
        message,
        options: needsInput
          ? [
              { value: 'answer', label: "I'll tell you where I am" },
              { value: 'keep', label: 'Leave it as UTC' },
            ]
          : [
              { value: 'keep', label: 'Keep UTC', hint: 'remote server / happy with UTC' },
              { value: 'answer', label: "I'm somewhere else" },
            ],
      }),
    ) as 'keep' | 'answer';
    setupLog.userInput('timezone_choice', choice);
  }

  if (choice === 'keep') return;

  const answer = ensureAnswer(
    await p.text({
      message: 'Where are you? (city, region, or IANA zone)',
      placeholder: 'e.g. New York, London, Asia/Tokyo',
      validate: (v) => (v && v.trim() ? undefined : 'Required'),
    }),
  );
  const raw = (answer as string).trim();
  setupLog.userInput('timezone_input', raw);

  let tz: string | null = isValidTimezone(raw) ? raw : null;
  if (!tz) {
    if (claudeCliAvailable()) {
      tz = await resolveTimezoneViaClaude(raw);
    } else {
      p.log.warn(
        brandBody(
          wrapForGutter(
            "That's not a standard IANA zone and I can't call Claude to interpret it here — try again with a zone like `America/New_York` or `Europe/London`.",
            4,
          ),
        ),
      );
    }
  }

  if (!tz) {
    // One retry with a direct-IANA ask; if that fails too, leave the
    // previously-detected value in .env and move on rather than looping.
    const retryAnswer = ensureAnswer(
      await p.text({
        message: 'Enter an IANA timezone string',
        placeholder: 'e.g. America/New_York',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required';
          if (!isValidTimezone(s)) return 'Not a valid IANA zone';
          return undefined;
        },
      }),
    );
    tz = (retryAnswer as string).trim();
    setupLog.userInput('timezone_retry', tz);
  }

  const persist = await runQuietStep(
    'timezone',
    {
      running: `Saving timezone ${tz}…`,
      done: `Timezone set to ${tz}.`,
    },
    ['--tz', tz],
  );
  if (!persist.ok) {
    await fail('timezone', `Couldn't save timezone ${tz}.`);
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

// ─── interactive / env helpers ─────────────────────────────────────────

function ensureLocalBinOnPath(): void {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const current = process.env.PATH ?? '';
  const segments = current.split(path.delimiter).filter(Boolean);
  if (segments.includes(localBin)) return;
  process.env.PATH = current ? `${localBin}${path.delimiter}${current}` : localBin;
}

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

/**
 * Probe the host for a working OneCLI install so we can offer to reuse it
 * instead of re-running the installer (which rebinds the listener and breaks
 * any other app already using that gateway).
 */
function detectExistingOnecli(): { version: string; apiHost: string } | null {
  try {
    const ver = spawnSync('onecli', ['version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ver.status !== 0) return null;
    const version = (ver.stdout ?? '').trim();
    if (!version) return null;

    const host = spawnSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (host.status !== 0) return null;
    const raw = (host.stdout ?? '').trim();
    if (!raw) return null;

    // onecli 1.3+ emits JSON by default. Older versions would print raw text.
    try {
      const parsed = JSON.parse(raw) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) {
        return { version, apiHost: val.trim() };
      }
    } catch {
      // not JSON — try to extract a URL directly
    }
    const m = raw.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
    return m ? { version, apiHost: m[0] } : null;
  } catch {
    return null;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn(brandBody('Docker socket not accessible in current group. Re-executing under `sg docker`.'));
  const existingSkip = (process.env.NANOCLAW_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const skipList = [...new Set([...existingSkip, ...setupLog.completedStepNames()])].join(',');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1', ...(skipList ? { NANOCLAW_SKIP: skipList } : {}) },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(`${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`);
    return;
  }

  // bash already printed the wordmark above us; the clack intro carries the
  // welcome framing alone so the two don't double up. Standalone runs of
  // setup:auto still see this as the first line — fine without the wordmark
  // since the line itself signals the start of the flow.
  p.intro("Let's get you set up.");
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
