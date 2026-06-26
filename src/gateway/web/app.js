const TOKEN_KEY = 'nc_session_token';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let editingWorkspaceId = null;
/** Preserves container_config fields not edited in the form (packages, mounts, etc.). */
let editingContainerConfig = null;

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
      <button type="button" class="secondary edit-agent-btn" data-id="${escapeAttr(agent.workspace_id)}">Edit</button>
    `;
    li.querySelector('.edit-agent-btn').addEventListener('click', () => openAgent(agent.workspace_id));
    list.appendChild(li);
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
  const token = getToken();
  if (!token) {
    setView('auth');
    return;
  }

  try {
    const data = await api('/v1/auth/me');
    currentUser = data.user;
    renderUserBar();
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

$('save-agent-btn').addEventListener('click', () => void saveAgent());

$('agent-name').addEventListener('input', () => {
  if (!editingWorkspaceId && !$('agent-folder').value.trim()) {
    $('agent-folder').placeholder = slugify($('agent-name').value);
  }
});

bootstrap();
