const TOKEN_KEY = 'nc_session_token';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let editingWorkspaceId = null;
/** Preserves container_config fields not edited in the form (packages, mounts, etc.). */
let editingContainerConfig = null;
/** From GET /v1/live-browser/enabled — hides Live browser UI when false. */
let liveBrowserEnabled = false;
let liveBrowserWs = null;
let liveBrowserWorkspaceId = null;
let liveBrowserInputEnabled = false;
/** Last pointer position in canvas CSS coords while controlling (for overlay). */
let liveBrowserPointer = null;
/** Last page URL from the stream (for blank-page hint). */
let liveBrowserPageUrl = '';
let liveBrowserFrameCount = 0;
/** CSS viewport size from the latest screencast frame (CDP coordinate space). */
let liveBrowserViewport = { width: 1280, height: 720 };
/** Bitmask of buttons currently held (CDP: left=1, middle=4, right=2). */
let liveBrowserButtonsDown = 0;
let liveBrowserLastMoveSentAt = 0;
let liveBrowserMoveTimer = null;
let liveBrowserPendingMove = null;
let liveBrowserLastFrameAt = 0;
let liveBrowserStallTimer = null;
let liveBrowserStallReconnects = 0;
/** Poll worker status while the modal is open so we pick up navigations / session switches. */
let liveBrowserStatusTimer = null;
let liveBrowserLastFrameBytes = 0;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function show(el) {
  el.classList.remove('hidden');
}

function hide(el) {
  el.classList.add('hidden');
}

function showAuthError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  show(el);
}

function clearAuthError() {
  hide($('auth-error'));
  $('auth-error').textContent = '';
}

function showEditorError(msg) {
  const el = $('editor-error');
  el.textContent = msg;
  show(el);
  hide($('editor-success'));
}

function showEditorSuccess(msg) {
  const el = $('editor-success');
  el.textContent = msg;
  show(el);
  hide($('editor-error'));
}

function clearEditorMessages() {
  hide($('editor-error'));
  hide($('editor-success'));
}

function slugify(name) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}

function setView(view) {
  hide($('auth-section'));
  hide($('dashboard-section'));
  hide($('editor-section'));

  if (view === 'auth') show($('auth-section'));
  if (view === 'dashboard') show($('dashboard-section'));
  if (view === 'editor') show($('editor-section'));
}

function renderUserBar() {
  if (!currentUser) {
    hide($('user-bar'));
    return;
  }
  $('user-name').textContent = currentUser.display_name;
  show($('user-bar'));
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isValidRelativePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized || normalized.includes('..') || pathIsAbsolute(normalized)) return false;
  return true;
}

function pathIsAbsolute(p) {
  return /^([a-zA-Z]:[/\\]|\/)/.test(p);
}

function findFileBlockByPath(targetPath) {
  const normalized = normalizeRelativePath(targetPath);
  return [...$('file-list').querySelectorAll('.file-block')].find(
    (block) => normalizeRelativePath(block.querySelector('.file-path').value) === normalized,
  );
}

function createFileBlock(path = 'CLAUDE.local.md', content = '', { uploaded = false } = {}) {
  const block = document.createElement('div');
  block.className = uploaded ? 'file-block uploaded' : 'file-block';
  block.innerHTML = `
    <p class="path-hint">Relative path in agent workspace</p>
    <header>
      <input type="text" class="file-path" value="${escapeAttr(path)}" placeholder="notes/context.md" />
      <button type="button" class="danger secondary remove-file-btn">Remove</button>
    </header>
    <textarea class="file-content" placeholder="Markdown content...">${escapeHtml(content)}</textarea>
  `;
  block.querySelector('.remove-file-btn').addEventListener('click', () => {
    block.remove();
    ensureAtLeastOneFile();
  });
  return block;
}

function addOrUpdateFileBlock(path, content, { uploaded = false } = {}) {
  const normalized = normalizeRelativePath(path);
  const existing = findFileBlockByPath(normalized);
  if (existing) {
    existing.querySelector('.file-path').value = normalized;
    existing.querySelector('.file-content').value = content;
    if (uploaded) existing.classList.add('uploaded');
    return existing;
  }
  const block = createFileBlock(normalized, content, { uploaded });
  $('file-list').appendChild(block);
  return block;
}

function isMarkdownFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.md') || name.endsWith('.markdown');
}

/** Strip shared top-level folder from folder uploads (e.g. my-agent/foo.md → foo.md). */
function relativePathFromUpload(file, fromFolder) {
  let relPath = file.webkitRelativePath
    ? normalizeRelativePath(file.webkitRelativePath)
    : normalizeRelativePath(file.name);

  if (!fromFolder || !relPath.includes('/')) return relPath;

  const parts = relPath.split('/');
  parts.shift();
  return parts.join('/');
}

async function importMdFiles(fileList, { fromFolder = false } = {}) {
  if (!fileList || fileList.length === 0) return;

  const entries = [...fileList].filter(isMarkdownFile);
  if (!entries.length) {
    showEditorError('No .md files selected');
    return;
  }

  clearEditorMessages();
  let imported = 0;

  for (const file of entries) {
    const relPath = relativePathFromUpload(file, fromFolder);
    if (!isValidRelativePath(relPath)) {
      showEditorError(`Invalid relative path: ${relPath}`);
      continue;
    }

    try {
      const content = await file.text();
      addOrUpdateFileBlock(relPath, content, { uploaded: true });
      imported += 1;
    } catch (err) {
      showEditorError(`Failed to read ${file.name}: ${err.message}`);
    }
  }

  ensureAtLeastOneFile();
  if (imported > 0) {
    showEditorSuccess(`Imported ${imported} file${imported === 1 ? '' : 's'}. Review paths before saving.`);
  }
}

function ensureAtLeastOneFile() {
  const list = $('file-list');
  if (list.children.length === 0) {
    list.appendChild(createFileBlock());
  }
}

function formatEnvLines(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function createMcpServerBlock(name = '', config = {}) {
  const block = document.createElement('div');
  block.className = 'mcp-block';
  const args = Array.isArray(config.args) ? config.args.join('\n') : '';
  block.innerHTML = `
    <p class="field-hint">Server name (key in container.json)</p>
    <header>
      <input type="text" class="mcp-name" value="${escapeAttr(name)}" placeholder="zoho-mcp" />
      <button type="button" class="danger secondary remove-mcp-btn">Remove</button>
    </header>
    <label class="field-hint" for="">Command</label>
    <input type="text" class="mcp-command" value="${escapeAttr(config.command || '')}" placeholder="npx" />
    <p class="field-hint">Arguments (one per line)</p>
    <textarea class="mcp-args mcp-compact" placeholder="mcp-remote&#10;https://example.com/mcp">${escapeHtml(args)}</textarea>
    <p class="field-hint">Environment (KEY=value, one per line)</p>
    <textarea class="mcp-env mcp-compact" placeholder="API_KEY=secret">${escapeHtml(formatEnvLines(config.env))}</textarea>
    <p class="field-hint">Instructions (optional — shown to the agent)</p>
    <textarea class="mcp-instructions" placeholder="When to use this MCP server...">${escapeHtml(config.instructions || '')}</textarea>
  `;
  block.querySelector('.remove-mcp-btn').addEventListener('click', () => block.remove());
  return block;
}

function resetMcpServers() {
  $('mcp-server-list').innerHTML = '';
}

function fillMcpServers(mcpServers) {
  resetMcpServers();
  const entries = Object.entries(mcpServers || {});
  if (!entries.length) return;
  for (const [name, config] of entries) {
    $('mcp-server-list').appendChild(createMcpServerBlock(name, config));
  }
}

function parseEnvLines(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid MCP env line (use KEY=value): ${line}`);
    }
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function collectMcpServers() {
  const servers = {};
  const names = new Set();
  for (const block of $('mcp-server-list').querySelectorAll('.mcp-block')) {
    const name = block.querySelector('.mcp-name').value.trim();
    const command = block.querySelector('.mcp-command').value.trim();
    const argsText = block.querySelector('.mcp-args').value;
    const envText = block.querySelector('.mcp-env').value;
    const instructions = block.querySelector('.mcp-instructions').value.trim();

    if (!name && !command && !argsText.trim() && !envText.trim() && !instructions) continue;
    if (!name) throw new Error('Each MCP server needs a name');
    if (!command) throw new Error(`MCP server "${name}" requires a command`);
    if (names.has(name)) throw new Error(`Duplicate MCP server name: ${name}`);
    names.add(name);

    const config = { command };
    const args = argsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (args.length) config.args = args;
    const env = parseEnvLines(envText);
    if (Object.keys(env).length) config.env = env;
    if (instructions) config.instructions = instructions;
    servers[name] = config;
  }
  return servers;
}

function buildContainerConfig() {
  const base = editingContainerConfig
    ? { ...editingContainerConfig }
    : {
        skills: 'all',
        packages: { apt: [], npm: [] },
        additionalMounts: [],
      };

  return {
    ...base,
    provider: $('agent-provider').value,
    model: $('agent-model').value.trim() || undefined,
    mcpServers: collectMcpServers(),
  };
}

function collectFiles() {
  const files = [...$('file-list').querySelectorAll('.file-block')].map((block) => ({
    path: normalizeRelativePath(block.querySelector('.file-path').value),
    content: block.querySelector('.file-content').value,
  }));

  const seen = new Set();
  for (const file of files) {
    if (!file.path) continue;
    if (!isValidRelativePath(file.path)) {
      throw new Error(`Invalid relative path: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate path: ${file.path}`);
    }
    seen.add(file.path);
  }

  return files.filter((f) => f.path);
}

function resetEditor() {
  editingWorkspaceId = null;
  editingContainerConfig = null;
  $('editor-title').textContent = 'New agent';
  $('agent-name').value = '';
  $('agent-folder').value = '';
  $('agent-provider').value = 'claude';
  $('agent-model').value = '';
  $('agent-cli-scope').value = 'group';
  $('agent-default').checked = false;
  $('file-list').innerHTML = '';
  $('file-list').appendChild(
    createFileBlock('CLAUDE.local.md', '# Agent Instructions\n\nYou are a helpful assistant.'),
  );
  resetMcpServers();
  clearEditorMessages();
  hide($('delete-agent-btn'));
}

function fillEditor(agent) {
  editingWorkspaceId = agent.workspace_id;
  editingContainerConfig = agent.container_config ? { ...agent.container_config } : null;
  $('editor-title').textContent = `Edit: ${agent.name}`;
  $('agent-name').value = agent.name;
  $('agent-folder').value = agent.folder || '';
  $('agent-provider').value = agent.container_config?.provider || 'claude';
  $('agent-model').value = agent.container_config?.model || '';
  $('agent-cli-scope').value = agent.cli_scope || 'group';
  $('agent-default').checked = Boolean(agent.is_default);
  fillMcpServers(agent.container_config?.mcpServers);

  $('file-list').innerHTML = '';
  for (const file of agent.files) {
    $('file-list').appendChild(createFileBlock(file.path, file.content));
  }
  ensureAtLeastOneFile();
  clearEditorMessages();
  show($('delete-agent-btn'));
}

async function loadAgents() {
  const data = await api('/v1/agents');
  const list = $('agent-list');
  list.innerHTML = '';

  if (!data.agents.length) {
    show($('no-agents'));
    return;
  }
  hide($('no-agents'));

  for (const agent of data.agents) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${escapeHtml(agent.name)}</strong>
        ${agent.is_default ? '<span class="badge default">default</span>' : ''}
        <div class="agent-meta">${escapeHtml(agent.workspace_id)} · ${agent.files?.length ?? 0} files</div>
      </div>
      <div class="agent-actions">
        ${
          liveBrowserEnabled
            ? `<button type="button" class="secondary live-browser-btn" data-id="${escapeAttr(agent.workspace_id)}" data-name="${escapeAttr(agent.name)}">Live browser</button>`
            : ''
        }
        <button type="button" class="secondary edit-agent-btn" data-id="${escapeAttr(agent.workspace_id)}">Edit</button>
        <button type="button" class="danger secondary delete-agent-btn" data-id="${escapeAttr(agent.workspace_id)}" data-name="${escapeAttr(agent.name)}">Delete</button>
      </div>
    `;
    const liveBtn = li.querySelector('.live-browser-btn');
    if (liveBtn) {
      liveBtn.addEventListener('click', () => openLiveBrowser(agent.workspace_id, agent.name));
    }
    li.querySelector('.edit-agent-btn').addEventListener('click', () => openAgent(agent.workspace_id));
    li.querySelector('.delete-agent-btn').addEventListener('click', () =>
      deleteAgent(agent.workspace_id, agent.name),
    );
    list.appendChild(li);
  }
}

function showCliqError(msg) {
  const el = $('cliq-error');
  el.textContent = msg;
  show(el);
  hide($('cliq-success'));
}

function showCliqSuccess(msg) {
  const el = $('cliq-success');
  el.textContent = msg;
  show(el);
  hide($('cliq-error'));
}

function clearCliqMessages() {
  hide($('cliq-error'));
  hide($('cliq-success'));
  $('cliq-error').textContent = '';
  $('cliq-success').textContent = '';
}

function renderCliqStatus(status) {
  const meta = $('cliq-status-meta');
  const actions = $('cliq-actions');
  actions.innerHTML = '';
  const oauthApp = status.oauth_app || {};
  const appConfigured = Boolean(status.oauth_app_configured || oauthApp.configured);
  const canManageOAuth = Boolean(currentUser?.is_admin && oauthApp.can_manage !== false);

  if (canManageOAuth) {
    show($('cliq-oauth-app'));
    $('cliq-account-heading').textContent = '2. Your Cliq account';
    const hint = $('cliq-oauth-app-hint');
    if (oauthApp.source === 'gateway_db') {
      hint.innerHTML =
        'Admin only. Gateway OAuth app is in <code>gateway.db</code> (shared). Bot name, channel endpoint, and chat IDs are set per user after Connect.';
    } else if (oauthApp.source === 'env') {
      hint.innerHTML =
        'Admin only. Client ID/Secret are currently from <code>.env</code>. Save them below into <code>gateway.db</code> (recommended). Bot/chat settings stay per-user.';
    } else {
      hint.innerHTML =
        'Admin only. Shared Client ID and Secret for all users. Saved to <code>gateway.db</code> — not per-user, not in git.';
    }

    if (oauthApp.client_id && !$('cliq-app-client-id').value.trim()) {
      $('cliq-app-client-id').value = oauthApp.client_id;
    }
    if (oauthApp.api_url && !$('cliq-app-api-url').value.trim()) {
      $('cliq-app-api-url').value = oauthApp.api_url;
    }
  } else {
    hide($('cliq-oauth-app'));
    $('cliq-account-heading').textContent = 'Your Cliq account';
  }

  if (!appConfigured) {
    meta.textContent = canManageOAuth
      ? 'Save the gateway OAuth app first (step 1)'
      : 'Waiting for an admin to configure the Zoho Cliq OAuth app';
    hide($('cliq-config'));
    return;
  }

  if (!status.connected) {
    meta.textContent = 'Not connected — authorize your Zoho account';
    hide($('cliq-config'));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Connect Zoho Cliq';
    btn.addEventListener('click', () => void connectCliq());
    actions.appendChild(btn);
    return;
  }

  const label = status.cliq_display_name || status.cliq_user_id || 'Connected';
  const chatCount = status.chat_ids?.length ?? 0;
  meta.innerHTML = `<span class="badge default">connected</span> ${escapeHtml(label)} · ${chatCount} chat${chatCount === 1 ? '' : 's'}`;

  $('cliq-chat-ids').value = (status.chat_ids || []).join(', ');
  $('cliq-bot-name').value =
    status.bot_unique_name || status.defaults?.bot_unique_name || '';
  $('cliq-channel-endpoint').value =
    status.channel_endpoint || status.defaults?.channel_endpoint || '';
  $('cliq-config-hint').textContent = chatCount
    ? 'These settings are only for your account. Gateway polls these chats with your token.'
    : 'Add at least one Chat ID, then Save — otherwise nothing is polled for your account.';
  show($('cliq-config'));
}

async function saveCliqOAuthApp() {
  clearCliqMessages();
  try {
    await api('/v1/channels/zoho-cliq/oauth-app', {
      method: 'PUT',
      body: JSON.stringify({
        client_id: $('cliq-app-client-id').value.trim(),
        client_secret: $('cliq-app-client-secret').value.trim(),
        api_url: $('cliq-app-api-url').value.trim() || undefined,
      }),
    });
    $('cliq-app-client-secret').value = '';
    showCliqSuccess('Gateway OAuth app saved. Next: Connect your Cliq account.');
    await loadCliqChannel();
  } catch (err) {
    showCliqError(err.message || 'Failed to save OAuth app');
  }
}

async function loadCliqChannel() {
  clearCliqMessages();
  try {
    const status = await api('/v1/channels/zoho-cliq');
    renderCliqStatus(status);
  } catch (err) {
    $('cliq-status-meta').textContent = err.message || 'Failed to load Cliq status';
    hide($('cliq-config'));
  }
}

async function connectCliq() {
  clearCliqMessages();
  try {
    const result = await api('/v1/channels/zoho-cliq/connect', { method: 'POST' });
    if (result.reused) {
      showCliqSuccess('Already connected.');
      await loadCliqChannel();
      return;
    }
    if (result.authorize_url) {
      window.location.href = result.authorize_url;
      return;
    }
    showCliqError('No authorize URL returned');
  } catch (err) {
    showCliqError(err.message || 'Connect failed');
  }
}

async function saveCliqConfig() {
  clearCliqMessages();
  const chat_ids = $('cliq-chat-ids')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const status = await api('/v1/channels/zoho-cliq', {
      method: 'PATCH',
      body: JSON.stringify({
        chat_ids,
        bot_unique_name: $('cliq-bot-name').value.trim() || null,
        channel_endpoint: $('cliq-channel-endpoint').value.trim() || null,
      }),
    });
    renderCliqStatus(status);
    showCliqSuccess('Cliq settings saved. Polling will use the updated chats.');
  } catch (err) {
    showCliqError(err.message || 'Save failed');
  }
}

async function disconnectCliq() {
  if (!confirm('Disconnect Zoho Cliq for your account?')) return;
  clearCliqMessages();
  try {
    await api('/v1/channels/zoho-cliq', { method: 'DELETE' });
    await loadCliqChannel();
    showCliqSuccess('Disconnected.');
  } catch (err) {
    showCliqError(err.message || 'Disconnect failed');
  }
}

async function deleteAgent(workspaceId, name) {
  if (!confirm(`Delete agent "${name}" permanently?`)) return;
  try {
    await api(`/v1/agents/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    if (editingWorkspaceId === workspaceId) {
      editingWorkspaceId = null;
      setView('dashboard');
    }
    await loadAgents();
  } catch (err) {
    alert(err.message || 'Failed to delete agent');
  }
}

async function openAgent(workspaceId) {
  const data = await api(`/v1/agents/${encodeURIComponent(workspaceId)}`);
  fillEditor(data.agent);
  setView('editor');
}

async function saveAgent() {
  clearEditorMessages();
  const name = $('agent-name').value.trim();
  if (!name) {
    showEditorError('Agent name is required');
    return;
  }

  let files;
  try {
    files = collectFiles();
  } catch (err) {
    showEditorError(err.message);
    return;
  }
  if (!files.length) {
    showEditorError('At least one file is required');
    return;
  }

  let container_config;
  try {
    container_config = buildContainerConfig();
  } catch (err) {
    showEditorError(err.message);
    return;
  }

  const payload = {
    name,
    folder: $('agent-folder').value.trim() || slugify(name),
    cli_scope: $('agent-cli-scope').value,
    is_default: $('agent-default').checked,
    container_config,
    files,
  };

  $('save-agent-btn').disabled = true;
  try {
    if (editingWorkspaceId) {
      await api(`/v1/agents/${encodeURIComponent(editingWorkspaceId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      showEditorSuccess('Agent updated and workspace prepared on worker.');
    } else {
      await api('/v1/agents', { method: 'POST', body: JSON.stringify(payload) });
      showEditorSuccess('Agent created and workspace prepared on worker.');
    }
    await loadAgents();
    setTimeout(() => setView('dashboard'), 800);
  } catch (err) {
    showEditorError(err.message);
  } finally {
    $('save-agent-btn').disabled = false;
  }
}

async function bootstrap() {
  await refreshLiveBrowserFlag();
  const token = getToken();
  if (!token) {
    setView('auth');
    return;
  }

  try {
    const data = await api('/v1/auth/me');
    currentUser = data.user;
    renderUserBar();
    await loadCliqChannel();
    await loadAgents();
    setView('dashboard');
  } catch {
    setToken(null);
    setView('auth');
  }
}

document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.authTab;
    hide($('login-form'));
    hide($('register-form'));
    show(tab === 'login' ? $('login-form') : $('register-form'));
    clearAuthError();
  });
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAuthError();
  try {
    const data = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('login-email').value,
        password: $('login-password').value,
      }),
    });
    setToken(data.token);
    currentUser = data.user;
    renderUserBar();
    await loadCliqChannel();
    await loadAgents();
    setView('dashboard');
  } catch (err) {
    showAuthError(err.message);
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAuthError();
  try {
    const data = await api('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        display_name: $('register-name').value,
        email: $('register-email').value,
        password: $('register-password').value,
      }),
    });
    setToken(data.token);
    currentUser = data.user;
    renderUserBar();
    setView('dashboard');
    await loadCliqChannel();
    await loadAgents();
  } catch (err) {
    showAuthError(err.message);
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/v1/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  setToken(null);
  currentUser = null;
  renderUserBar();
  setView('auth');
});

$('new-agent-btn').addEventListener('click', () => {
  resetEditor();
  setView('editor');
});

$('add-file-btn').addEventListener('click', () => {
  $('file-list').appendChild(createFileBlock('notes/new-file.md', ''));
});

$('add-mcp-server-btn').addEventListener('click', () => {
  $('mcp-server-list').appendChild(createMcpServerBlock());
});

$('md-upload-input').addEventListener('change', (e) => {
  void importMdFiles(e.target.files, { fromFolder: false }).finally(() => {
    e.target.value = '';
  });
});

$('md-folder-input').addEventListener('change', (e) => {
  void importMdFiles(e.target.files, { fromFolder: true }).finally(() => {
    e.target.value = '';
  });
});

$('cancel-editor-btn').addEventListener('click', () => {
  setView('dashboard');
});

$('delete-agent-btn').addEventListener('click', () => {
  if (!editingWorkspaceId) return;
  void deleteAgent(editingWorkspaceId, $('agent-name').value.trim() || 'this agent');
});

$('save-agent-btn').addEventListener('click', () => void saveAgent());

$('cliq-save-btn').addEventListener('click', () => void saveCliqConfig());
$('cliq-disconnect-btn').addEventListener('click', () => void disconnectCliq());
$('cliq-save-oauth-app-btn').addEventListener('click', () => void saveCliqOAuthApp());

$('agent-name').addEventListener('input', () => {
  if (!editingWorkspaceId && !$('agent-folder').value.trim()) {
    $('agent-folder').placeholder = slugify($('agent-name').value);
  }
});

async function refreshLiveBrowserFlag() {
  try {
    const data = await fetch('/v1/live-browser/enabled').then((r) => r.json());
    liveBrowserEnabled = Boolean(data.enabled);
  } catch {
    liveBrowserEnabled = false;
  }
}

function setLiveBrowserStatus(text) {
  $('live-browser-status').textContent = text;
}

function setLiveBrowserControlUi(controlling) {
  liveBrowserInputEnabled = controlling;
  liveBrowserButtonsDown = 0;
  liveBrowserPendingMove = null;
  if (liveBrowserMoveTimer) {
    clearTimeout(liveBrowserMoveTimer);
    liveBrowserMoveTimer = null;
  }
  const banner = $('live-browser-control-banner');
  const canvas = $('live-browser-canvas');
  const takeBtn = $('live-browser-take');
  const releaseBtn = $('live-browser-release');
  const cursor = $('live-browser-cursor');

  if (controlling) {
    banner.textContent = 'You have control — click and type on the viewport';
    banner.classList.add('is-controlling');
    show(banner);
    canvas.classList.add('live-browser-controlling');
    takeBtn.disabled = true;
    takeBtn.textContent = 'Controlling…';
    releaseBtn.disabled = false;
    canvas.focus();
  } else {
    banner.textContent = 'View only — click Take control to interact';
    banner.classList.remove('is-controlling');
    show(banner);
    canvas.classList.remove('live-browser-controlling');
    takeBtn.disabled = false;
    takeBtn.textContent = 'Take control';
    releaseBtn.disabled = true;
    hide(cursor);
  }
}

function stopLiveBrowserStatusPoll() {
  if (liveBrowserStatusTimer) {
    clearInterval(liveBrowserStatusTimer);
    liveBrowserStatusTimer = null;
  }
}

function closeLiveBrowser() {
  if (liveBrowserWs) {
    liveBrowserWs.close();
    liveBrowserWs = null;
  }
  if (liveBrowserStallTimer) {
    clearInterval(liveBrowserStallTimer);
    liveBrowserStallTimer = null;
  }
  stopLiveBrowserStatusPoll();
  liveBrowserWorkspaceId = null;
  setLiveBrowserControlUi(false);
  liveBrowserPointer = null;
  hide($('live-browser-modal'));
  $('live-browser-modal').setAttribute('aria-hidden', 'true');
}

function canvasCoords(ev) {
  const canvas = $('live-browser-canvas');
  const rect = canvas.getBoundingClientRect();
  // Map from the *displayed* canvas box into CDP CSS pixels. Prefer the
  // screencast deviceWidth/Height (viewport) over the bitmap size in case the
  // JPEG was downscaled for streaming.
  const vw = liveBrowserViewport.width || canvas.width || 1;
  const vh = liveBrowserViewport.height || canvas.height || 1;
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = ((ev.clientX - rect.left) / rect.width) * vw;
  const y = ((ev.clientY - rect.top) / rect.height) * vh;
  return {
    x: Math.max(0, Math.min(vw - 1, Math.round(x))),
    y: Math.max(0, Math.min(vh - 1, Math.round(y))),
  };
}

function liveBrowserMouseButton(ev) {
  if (ev.button === 2) return 'right';
  if (ev.button === 1) return 'middle';
  return 'left';
}

function liveBrowserButtonMask(button) {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1; // left
}

/** CDP text payload for keyDown — required for printable keys / Enter / Tab. */
function liveBrowserKeyText(key, modifiers) {
  // Ctrl/Meta chords must not insert text (e.g. Ctrl+A).
  if (modifiers & (2 | 4)) return undefined;
  if (key === 'Enter') return '\r';
  if (key === 'Tab') return '\t';
  if (key === ' ') return ' ';
  if (key.length === 1) return key;
  return undefined;
}

function liveBrowserKeyModifiers(ev) {
  let modifiers = 0;
  if (ev.altKey) modifiers |= 1;
  if (ev.ctrlKey) modifiers |= 2;
  if (ev.metaKey) modifiers |= 4;
  if (ev.shiftKey) modifiers |= 8;
  return modifiers;
}

function moveLiveCursor(clientX, clientY) {
  const stage = document.querySelector('.live-browser-stage');
  const canvas = $('live-browser-canvas');
  const cursor = $('live-browser-cursor');
  if (!stage || !canvas || !liveBrowserInputEnabled) {
    hide(cursor);
    return;
  }
  // Position relative to the stage, but clamp to the canvas box so the
  // overlay matches the coordinates we send to CDP.
  const stageRect = stage.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  cursor.style.left = `${clientX - stageRect.left}px`;
  cursor.style.top = `${clientY - stageRect.top}px`;
  const overCanvas =
    clientX >= canvasRect.left &&
    clientX <= canvasRect.right &&
    clientY >= canvasRect.top &&
    clientY <= canvasRect.bottom;
  if (overCanvas) show(cursor);
  else hide(cursor);
}

function sendLiveInput(msg) {
  if (!liveBrowserInputEnabled || !liveBrowserWs || liveBrowserWs.readyState !== WebSocket.OPEN) return false;
  liveBrowserWs.send(JSON.stringify(msg));
  return true;
}

/** Always move first — CDP often ignores press/release that never hovered the point. */
function sendLiveMouseMove(x, y, force = false) {
  const now = Date.now();
  liveBrowserPendingMove = { x, y };
  if (!force && now - liveBrowserLastMoveSentAt < 32) {
    if (!liveBrowserMoveTimer) {
      liveBrowserMoveTimer = setTimeout(() => {
        liveBrowserMoveTimer = null;
        if (liveBrowserPendingMove) {
          sendLiveMouseMove(liveBrowserPendingMove.x, liveBrowserPendingMove.y, true);
        }
      }, 32);
    }
    return;
  }
  liveBrowserLastMoveSentAt = now;
  liveBrowserPendingMove = null;
  sendLiveInput({
    type: 'input_mouse',
    eventType: 'mouseMoved',
    x,
    y,
  });
}

function isBlankBrowserUrl(url) {
  if (!url) return false;
  return (
    url === 'about:blank' ||
    url === 'chrome://newtab/' ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-error://')
  );
}

/**
 * Blank overlay must only show when we *know* the page is blank AND we have not
 * received a substantial JPEG yet. Large frames mean the stream is showing real
 * content even if the URL event is stale/missing.
 */
function updateBlankPageOverlay(url, opts = {}) {
  if (opts.reset) {
    liveBrowserPageUrl = '';
    liveBrowserLastFrameBytes = 0;
  } else if (typeof url === 'string' && url) {
    liveBrowserPageUrl = url;
  }

  const blank = $('live-browser-blank');
  const title = blank?.querySelector('strong');
  const detail = blank?.querySelector('span');
  const knownBlank = isBlankBrowserUrl(liveBrowserPageUrl);
  const hasSubstantialFrame = liveBrowserLastFrameBytes >= 5000 || liveBrowserFrameCount > 1;
  // Cover black canvas while waiting — empty #000 looks like a "broken" stream.
  const cover =
    (knownBlank && !hasSubstantialFrame) ||
    (liveBrowserFrameCount === 0 && !hasSubstantialFrame);

  if (title) {
    title.innerHTML = knownBlank
      ? `Page is blank (<code>${escapeHtml(liveBrowserPageUrl || 'about:blank')}</code>)`
      : 'Waiting for page URL…';
  }
  if (detail) {
    detail.textContent = knownBlank
      ? 'Live stream is connected, but Chromium has no real page open. In chat, ask the agent to open the site you want (e.g. “Open https://… and keep it open”), then click Reconnect.'
      : 'Stream connected. URL updates arrive on navigation; the viewport above is live.';
  }

  if (cover) show(blank);
  else hide(blank);
}

function paintLiveFrame(msg, ws) {
  // Ack when present (harmless under push pacing; required if server is in ack mode).
  if (ws.readyState === WebSocket.OPEN && msg.seq != null) {
    ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }));
  }

  const raw = typeof msg.data === 'string' ? msg.data : '';
  if (!raw) return;
  liveBrowserLastFrameBytes = raw.length;
  const src = raw.startsWith('data:') ? raw : `data:image/jpeg;base64,${raw}`;
  const img = new Image();
  img.onload = () => {
    const canvas = $('live-browser-canvas');
    const ctx = canvas.getContext('2d');
    const w = msg.metadata?.deviceWidth || img.naturalWidth || canvas.width;
    const h = msg.metadata?.deviceHeight || img.naturalHeight || canvas.height;
    if (w > 0 && h > 0) {
      liveBrowserViewport = { width: w, height: h };
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    liveBrowserFrameCount += 1;
    liveBrowserLastFrameAt = Date.now();
    if (liveBrowserFrameCount === 1 || liveBrowserFrameCount % 15 === 0) {
      const urlPart = liveBrowserPageUrl ? ` · ${liveBrowserPageUrl}` : '';
      if (!liveBrowserInputEnabled) {
        const blankHint =
          isBlankBrowserUrl(liveBrowserPageUrl) && liveBrowserLastFrameBytes < 5000
            ? ' · page is blank — ask the agent to open a URL'
            : '';
        setLiveBrowserStatus(
          `Streaming · ${canvas.width}×${canvas.height} · frames=${liveBrowserFrameCount}${urlPart}${blankHint}`,
        );
      }
    }
    // Hide the connect-time blank cover as soon as real frames arrive.
    updateBlankPageOverlay();
  };
  img.onerror = () => {
    setLiveBrowserStatus('Received a frame but failed to decode JPEG');
  };
  img.src = src;
}

async function connectLiveBrowserStream(workspaceId) {
  const prevWs = liveBrowserWs;
  liveBrowserWs = null;
  if (prevWs) {
    try {
      prevWs.onclose = null;
      prevWs.onerror = null;
      prevWs.onmessage = null;
      prevWs.close();
    } catch {
      // ignore
    }
  }

  const wasControlling = liveBrowserInputEnabled;
  liveBrowserFrameCount = 0;
  liveBrowserLastFrameBytes = 0;
  updateBlankPageOverlay('', { reset: true });
  setLiveBrowserStatus('Requesting ticket…');
  stopLiveBrowserStatusPoll();
  const ticketRes = await api(`/v1/agents/${encodeURIComponent(workspaceId)}/live-browser/ticket`, {
    method: 'POST',
    body: '{}',
  });

  const status = await api(`/v1/agents/${encodeURIComponent(workspaceId)}/live-browser/status`);
  if (!status.available) {
    setLiveBrowserStatus(status.reason || 'Container not running with live browser');
    updateBlankPageOverlay('about:blank');
    return;
  }
  if (status.page_url) {
    updateBlankPageOverlay(status.page_url);
  }
  if (!status.stream_ready) {
    setLiveBrowserStatus(
      status.hint ||
        'Waiting for agent-browser stream. When the agent has a page open, click Reconnect.',
    );
    updateBlankPageOverlay(status.page_url || 'about:blank');
    // Poll and auto-connect once the stream port is up — do not navigate for the agent.
    liveBrowserStatusTimer = setInterval(() => {
      if (!liveBrowserWorkspaceId) return;
      void api(`/v1/agents/${encodeURIComponent(liveBrowserWorkspaceId)}/live-browser/status`)
        .then((st) => {
          if (!liveBrowserWorkspaceId) return;
          if (st.page_url) updateBlankPageOverlay(st.page_url);
          if (st.stream_ready) {
            setLiveBrowserStatus(
              st.page_url
                ? `Stream ready · ${st.page_url} · connecting…`
                : 'Stream ready · connecting…',
            );
            void connectLiveBrowserStream(liveBrowserWorkspaceId);
          }
        })
        .catch(() => {});
    }, 2500);
    return;
  }
  setLiveBrowserStatus(
    isBlankBrowserUrl(status.page_url)
      ? `Stream connected · page is ${status.page_url || 'about:blank'} (showing current Chromium view)`
      : `Stream ready · ${status.page_url} · control=${status.control || 'agent'} · connecting…`,
  );

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}${ticketRes.stream_path}?ticket=${encodeURIComponent(ticketRes.ticket)}`;
  const ws = new WebSocket(wsUrl);
  liveBrowserWs = ws;
  let opened = false;

  // Keep URL/port in sync with the worker while the modal is open. If the agent
  // navigates (or we were on a blank session), reconnect once content is ready.
  liveBrowserStatusTimer = setInterval(() => {
    if (!liveBrowserWorkspaceId || liveBrowserWs !== ws) return;
    void api(`/v1/agents/${encodeURIComponent(liveBrowserWorkspaceId)}/live-browser/status`)
      .then((st) => {
        if (!liveBrowserWorkspaceId || liveBrowserWs !== ws) return;
        if (st.page_url) updateBlankPageOverlay(st.page_url);
        const stuckBlank =
          liveBrowserFrameCount <= 1 &&
          liveBrowserLastFrameBytes < 5000 &&
          isBlankBrowserUrl(liveBrowserPageUrl);
        const statusHasPage = st.page_url && !isBlankBrowserUrl(st.page_url);
        if (
          stuckBlank &&
          statusHasPage &&
          st.stream_ready &&
          liveBrowserStallReconnects < 3
        ) {
          liveBrowserStallReconnects += 1;
          setLiveBrowserStatus(
            `Agent page is ${st.page_url} — reconnecting live view to the right session…`,
          );
          void connectLiveBrowserStream(liveBrowserWorkspaceId);
        }
      })
      .catch(() => {});
  }, 3000);

  ws.onopen = () => {
    opened = true;
    liveBrowserLastFrameAt = Date.now();
    liveBrowserStallReconnects = 0;
    // Keep in sync with worker upstream `/?pacing=push&maxFps=8`.
    ws.send(JSON.stringify({ type: 'config', maxFps: 8, pacing: 'push' }));
    setLiveBrowserStatus(
      wasControlling
        ? 'Streaming — you have control'
        : `Streaming · view only · control=${status.control || 'agent'}`,
    );
    if (wasControlling) setLiveBrowserControlUi(true);
    if (liveBrowserStallTimer) clearInterval(liveBrowserStallTimer);
    // agent-browser can freeze after the first blank frame; reconnect when stalled.
    liveBrowserStallTimer = setInterval(() => {
      if (liveBrowserWs !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (!liveBrowserLastFrameAt) return;
      const stalled = Date.now() - liveBrowserLastFrameAt > 6000;
      const stuckOnFirstBlank =
        liveBrowserFrameCount <= 1 &&
        liveBrowserLastFrameBytes < 5000 &&
        isBlankBrowserUrl(liveBrowserPageUrl);
      if (stalled && stuckOnFirstBlank && liveBrowserStallReconnects < 3 && liveBrowserWorkspaceId) {
        liveBrowserStallReconnects += 1;
        setLiveBrowserStatus('Stream stalled on blank frame — reconnecting…');
        void connectLiveBrowserStream(liveBrowserWorkspaceId);
      }
    }, 3000);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      // Ignore unexpected binary frames.
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'frame' && msg.data) {
      paintLiveFrame(msg, ws);
    } else if (msg.type === 'status') {
      if (!liveBrowserInputEnabled) {
        setLiveBrowserStatus(
          `Streaming · viewport ${msg.viewportWidth || '?'}×${msg.viewportHeight || '?'} · screencast=${msg.screencasting}`,
        );
      }
    } else if (msg.type === 'url') {
      updateBlankPageOverlay(msg.url || '');
      if (!liveBrowserInputEnabled) {
        setLiveBrowserStatus(`Page: ${msg.url || '(none)'}`);
      }
    } else if (msg.type === 'tabs' && Array.isArray(msg.tabs)) {
      // On connect, agent-browser may send tabs (with urls) before any navigation `url` event.
      const active =
        msg.tabs.find((t) => t && (t.active || t.selected || t.current)) || msg.tabs[0];
      const tabUrl = active && (active.url || active.URL);
      if (typeof tabUrl === 'string' && tabUrl) {
        updateBlankPageOverlay(tabUrl);
        if (!liveBrowserInputEnabled) {
          setLiveBrowserStatus(`Page: ${tabUrl}`);
        }
      }
    }
  };

  ws.onerror = () => {
    if (liveBrowserWs === ws) {
      setLiveBrowserStatus('WebSocket error — click Reconnect');
    }
  };
  ws.onclose = (ev) => {
    if (liveBrowserWs !== ws) return;
    liveBrowserWs = null;
    if (liveBrowserStallTimer) {
      clearInterval(liveBrowserStallTimer);
      liveBrowserStallTimer = null;
    }
    stopLiveBrowserStatusPoll();
    const why = ev.reason || (opened ? 'connection closed' : 'upgrade failed');
    setLiveBrowserStatus(
      `Disconnected (${ev.code}${why ? `: ${why}` : ''}). If the agent has a page open, click Reconnect.`,
    );
  };
}

async function openLiveBrowser(workspaceId, name) {
  liveBrowserWorkspaceId = workspaceId;
  setLiveBrowserControlUi(false);
  liveBrowserPointer = null;
  $('live-browser-title').textContent = `Live browser — ${name}`;
  show($('live-browser-modal'));
  $('live-browser-modal').setAttribute('aria-hidden', 'false');
  try {
    await connectLiveBrowserStream(workspaceId);
  } catch (err) {
    setLiveBrowserStatus(err.message || 'Failed to open live browser');
  }
}

async function liveBrowserTakeControl() {
  if (!liveBrowserWorkspaceId) return;
  const takeBtn = $('live-browser-take');
  takeBtn.disabled = true;
  takeBtn.textContent = 'Taking control…';
  try {
    await api(`/v1/agents/${encodeURIComponent(liveBrowserWorkspaceId)}/live-browser/take-control`, {
      method: 'POST',
      body: '{}',
    });
    setLiveBrowserControlUi(true);
    setLiveBrowserStatus('You have control — click/type on the viewport');
  } catch (err) {
    setLiveBrowserControlUi(false);
    setLiveBrowserStatus(err.message || 'Take control failed');
  }
}

async function liveBrowserReleaseControl() {
  if (!liveBrowserWorkspaceId) return;
  const releaseBtn = $('live-browser-release');
  releaseBtn.disabled = true;
  releaseBtn.textContent = 'Releasing…';
  try {
    await api(
      `/v1/agents/${encodeURIComponent(liveBrowserWorkspaceId)}/live-browser/release-control`,
      { method: 'POST', body: '{}' },
    );
    setLiveBrowserControlUi(false);
    $('live-browser-release').textContent = 'Release & continue';
    setLiveBrowserStatus('Released — agent will continue from the current page');
  } catch (err) {
    setLiveBrowserControlUi(true);
    $('live-browser-release').textContent = 'Release & continue';
    setLiveBrowserStatus(err.message || 'Release failed');
  }
}

$('live-browser-close').addEventListener('click', () => closeLiveBrowser());
$('live-browser-backdrop').addEventListener('click', () => closeLiveBrowser());
$('live-browser-take').addEventListener('click', () => void liveBrowserTakeControl());
$('live-browser-release').addEventListener('click', () => void liveBrowserReleaseControl());
$('live-browser-reconnect').addEventListener('click', () => {
  if (liveBrowserWorkspaceId) void connectLiveBrowserStream(liveBrowserWorkspaceId);
});

$('live-browser-canvas').addEventListener('pointerdown', (ev) => {
  if (!liveBrowserInputEnabled) return;
  ev.preventDefault();
  const canvas = $('live-browser-canvas');
  canvas.focus();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    // ignore
  }
  const { x, y } = canvasCoords(ev);
  liveBrowserPointer = { x, y };
  moveLiveCursor(ev.clientX, ev.clientY);
  const button = liveBrowserMouseButton(ev);
  const mask = liveBrowserButtonMask(button);
  // Move to point, then press (release on pointerup — supports drag).
  sendLiveMouseMove(x, y, true);
  liveBrowserButtonsDown |= mask;
  const ok = sendLiveInput({
    type: 'input_mouse',
    eventType: 'mousePressed',
    x,
    y,
    button,
    clickCount: ev.detail || 1,
  });
  if (ok) {
    setLiveBrowserStatus(`Controlling · click (${x}, ${y})`);
  } else {
    setLiveBrowserStatus('Input not sent — stream disconnected. Click Reconnect.');
  }
});
$('live-browser-canvas').addEventListener('pointerup', (ev) => {
  if (!liveBrowserInputEnabled) return;
  const { x, y } = canvasCoords(ev);
  liveBrowserPointer = { x, y };
  moveLiveCursor(ev.clientX, ev.clientY);
  const button = liveBrowserMouseButton(ev);
  const mask = liveBrowserButtonMask(button);
  liveBrowserButtonsDown &= ~mask;
  sendLiveInput({
    type: 'input_mouse',
    eventType: 'mouseReleased',
    x,
    y,
    button,
    clickCount: ev.detail || 1,
  });
  try {
    $('live-browser-canvas').releasePointerCapture(ev.pointerId);
  } catch {
    // ignore
  }
});
$('live-browser-canvas').addEventListener('pointermove', (ev) => {
  if (!liveBrowserInputEnabled) return;
  const { x, y } = canvasCoords(ev);
  liveBrowserPointer = { x, y };
  moveLiveCursor(ev.clientX, ev.clientY);
  // Throttle remote moves — docker-exec relay drops/delays input when flooded.
  sendLiveMouseMove(x, y, false);
});
$('live-browser-canvas').addEventListener('wheel', (ev) => {
  if (!liveBrowserInputEnabled) return;
  ev.preventDefault();
  const { x, y } = canvasCoords(ev);
  sendLiveMouseMove(x, y, true);
  sendLiveInput({
    type: 'input_mouse',
    eventType: 'mouseWheel',
    x,
    y,
    deltaX: ev.deltaX,
    deltaY: ev.deltaY,
  });
}, { passive: false });
$('live-browser-canvas').addEventListener('contextmenu', (ev) => {
  if (liveBrowserInputEnabled) ev.preventDefault();
});
window.addEventListener('keydown', (ev) => {
  if (!liveBrowserInputEnabled || $('live-browser-modal').classList.contains('hidden')) return;
  if (ev.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  // Keep focus on the canvas so subsequent keys keep routing here.
  $('live-browser-canvas').focus();
  ev.preventDefault();
  const modifiers = liveBrowserKeyModifiers(ev);
  const text = liveBrowserKeyText(ev.key, modifiers);
  const keyDown = {
    type: 'input_keyboard',
    eventType: 'keyDown',
    key: ev.key,
    code: ev.code,
    modifiers,
  };
  // CDP inserts from keyDown when `text` is set (Enter needs "\r", letters need themselves).
  if (text !== undefined) keyDown.text = text;
  const ok = sendLiveInput(keyDown);
  if (ok && text !== undefined) {
    setLiveBrowserStatus(`Controlling · typed ${JSON.stringify(text)}`);
  }
});
window.addEventListener('keyup', (ev) => {
  if (!liveBrowserInputEnabled || $('live-browser-modal').classList.contains('hidden')) return;
  if (ev.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  const modifiers = liveBrowserKeyModifiers(ev);
  sendLiveInput({
    type: 'input_keyboard',
    eventType: 'keyUp',
    key: ev.key,
    code: ev.code,
    modifiers,
  });
});

bootstrap();
