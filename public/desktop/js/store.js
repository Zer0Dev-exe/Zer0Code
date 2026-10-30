import { api, auth, AuthError, connectSocket } from './api.js';
import { basename, toast } from './dom.js';

// Estado de la app y todo lo que habla con el servidor. La interfaz se suscribe con on(evento, fn).

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(`[${event}]`, err); }
  }
}

const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));

export const state = {
  user: null,
  profile: null,
  conn: 'connecting',
  providers: {},
  models: [],
  defaultModel: null,
  appMode: 'Hoster',
  authInfo: null,

  sessions: [],
  activeId: null, // null = hilo nuevo (borrador)
  session: null,
  messages: [],
  loading: false,

  running: false,
  sending: false, // este cliente acaba de enviar un mensaje desde un hilo nuevo
  liveSessionId: null,
  phase: null,
  perms: new Map(),
  unread: new Set(),

  workspace: '',
  projects: readJson('z0d_projects', []),
  gitSummary: {},
  changes: null,

  orch: null,
  update: null, // estado de las actualizaciones de la app de escritorio

  pins: new Set(readJson('z0d_pins', [])),
  ui: {
    sidebar: readJson('z0d_sidebar', true),
    panel: { open: readJson('z0d_panel', false), tab: 'changes' },
    filter: localStorage.getItem('z0d_filter') || 'all',
    settledOpen: readJson('z0d_settled_open', false),
    theme: localStorage.getItem('z0d_theme') || 'dark'
  },
  prefs: {
    model: localStorage.getItem('z0d_model') || null,
    effort: localStorage.getItem('z0d_effort') || 'auto',
    mode: localStorage.getItem('z0d_mode') || 'auto'
  },
  drafts: new Map()
};

// --------------------------------------------------------------------------
// Preferencias de interfaz
// --------------------------------------------------------------------------
export function setUi(patch) {
  Object.assign(state.ui, patch);
  write('z0d_sidebar', state.ui.sidebar);
  write('z0d_panel', state.ui.panel.open);
  write('z0d_filter', state.ui.filter);
  write('z0d_settled_open', state.ui.settledOpen);
  write('z0d_theme', state.ui.theme);
  emit('ui');
}

export function setPanel(patch) {
  Object.assign(state.ui.panel, patch);
  setUi({});
  if (state.ui.panel.open) refreshChanges();
}

export function applyTheme() {
  let theme = state.ui.theme;
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  window.Zer0CodeDesktop?.setTheme?.(theme);
}

export function setPref(key, value) {
  state.prefs[key] = value;
  write(`z0d_${key}`, String(value));
  emit('prefs');
}

export function togglePin(id) {
  if (state.pins.has(id)) state.pins.delete(id);
  else state.pins.add(id);
  write('z0d_pins', [...state.pins]);
  emit('sessions');
}

// --------------------------------------------------------------------------
// Datos derivados
// --------------------------------------------------------------------------
export const modelInfo = (id) => state.models.find(m => m.id === id) || { id, name: id || '—', provider: 'claude' };
export const providerOfModel = (id) => modelInfo(id).provider || 'claude';

export function currentModelId() {
  const wanted = state.prefs.model;
  if (wanted && state.models.some(m => m.id === wanted)) return wanted;
  return state.defaultModel || state.models[0]?.id || null;
}

export function effortLevelsFor(modelId) {
  const m = state.models.find(x => x.id === modelId);
  return m && Array.isArray(m.effortLevels) ? m.effortLevels : [];
}

export function activeWorkspace() {
  return state.session?.workspace || state.workspace || '';
}

/** Proyectos conocidos: carpetas de las conversaciones, las añadidas a mano y la actual */
export function projectList() {
  const seen = new Map();
  const add = (dir, ts = 0) => {
    if (!dir) return;
    const prev = seen.get(dir);
    if (!prev || ts > prev.ts) seen.set(dir, { dir, name: basename(dir), ts });
  };
  for (const s of state.sessions) add(s.workspace, s.updatedAt);
  for (const dir of state.projects) add(dir, 0);
  add(state.workspace, 0);
  return [...seen.values()].sort((a, b) => b.ts - a.ts);
}

export function addProject(dir) {
  if (!dir) return;
  if (!state.projects.includes(dir)) {
    state.projects.unshift(dir);
    write('z0d_projects', state.projects.slice(0, 50));
  }
  state.workspace = dir;
  emit('sessions');
  emit('composer');
  loadGitSummary(dir);
}

export function sessionStatus(id) {
  if (state.running && state.liveSessionId === id) return state.phase === 'reviewing' ? 'reviewing' : 'running';
  for (const p of state.perms.values()) if (p.sessionId === id) return 'pending';
  if (state.unread.has(id)) return 'unread';
  return null;
}

// --------------------------------------------------------------------------
// Carga
// --------------------------------------------------------------------------
export async function loadStatus() {
  const s = await api('/api/status');
  state.user = s.user || state.user;
  state.providers = s.providers || {};
  state.models = s.availableModels || [];
  state.defaultModel = s.defaultModel || null;
  state.appMode = s.appMode;
  state.authInfo = s.auth;
  loadIdentityProfile();
  if (!state.workspace) state.workspace = s.currentWorkspace || '';
  emit('status');
  emit('composer');
}

export async function loadSessions() {
  const data = await api('/api/sessions');
  state.sessions = data.sessions || [];
  const mine = state.sessions.find(s => s.id === state.activeId);
  if (mine && state.session && state.session.title !== mine.title) { state.session = { ...state.session, title: mine.title }; emit('thread'); }
  emit('sessions');
  // Rama y cambios de cada proyecto (para las filas del sidebar)
  for (const p of projectList().slice(0, 12)) loadGitSummary(p.dir);
}

async function loadIdentityProfile() {
  const username = state.user?.username;
  try {
    const result = await api('/api/profile');
    if (result.success && state.user?.username === username) {
      state.profile = result.profile;
      emit('profile');
    }
  } catch {}
}

export async function saveDisplayName(displayName) {
  const username = state.user?.username;
  const result = await api('/api/profile', { method: 'PATCH', body: { displayName } });
  if (!result.success) throw new Error(result.error || 'No se pudo guardar el nombre visible.');
  if (state.user?.username !== username) throw new Error('La sesión ha cambiado.');
  state.profile = result.profile;
  emit('profile');
}

const gitFetchedAt = new Map();
export async function loadGitSummary(dir, { force = false } = {}) {
  if (!dir) return;
  if (!force && Date.now() - (gitFetchedAt.get(dir) || 0) < 20000) return;
  gitFetchedAt.set(dir, Date.now());
  try {
    const data = await api(`/api/git/summary?workspace=${encodeURIComponent(dir)}`);
    if (data.success) {
      state.gitSummary[dir] = data;
      emit('git');
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
}

export async function refreshChanges() {
  const dir = activeWorkspace();
  if (!dir) return;
  state.changes = { ...(state.changes || {}), loading: true, dir };
  emit('changes');
  try {
    const data = await api(`/api/git/changes?workspace=${encodeURIComponent(dir)}`);
    if (dir === activeWorkspace()) state.changes = { ...data, dir, loading: false };
  } catch {
    state.changes = { isRepo: false, files: [], dir, loading: false, error: true };
  }
  emit('changes');
  loadGitSummary(dir, { force: true });
}

export async function loadOrchestration() {
  try {
    const data = await api('/api/orchestration');
    if (data.success) { state.orch = data; emit('orch'); }
  } catch { /* sin orquestador en un servidor antiguo */ }
}

export async function saveOrchestration(patch) {
  const data = await api('/api/orchestration', { method: 'PUT', body: patch });
  if (data.success) { state.orch = data; emit('orch'); }
  return data;
}

// --------------------------------------------------------------------------
// Hilos
// --------------------------------------------------------------------------
let resync = null;
let lastSeq = 0;

export async function openSession(id) {
  state.activeId = id;
  state.unread.delete(id);
  state.loading = true;
  resync = [];
  emit('thread');
  try {
    const data = await api(`/api/sessions/${id}`);
    if (!data.session) throw new Error('Conversación no encontrada');
    if (state.activeId !== id) return;
    state.session = data.session;
    state.messages = [...(data.session.messages || [])];
    if (data.workspaceMissing) toast('La carpeta de este proyecto ya no existe');
    if (data.liveTask) {
      const live = data.liveTask;
      state.running = true;
      state.liveSessionId = live.sessionId;
      lastSeq = live.seq || 0;
      if (live.message) state.messages.push({ ...live.message });
    } else if (state.liveSessionId === id) {
      state.running = false;
    }
    state.workspace = data.session.workspace || state.workspace;
  } catch (err) {
    toast(err.message || 'No se pudo abrir la conversación', 'error');
    state.activeId = null;
    state.session = null;
    state.messages = [];
  } finally {
    state.loading = false;
    const buffered = resync || [];
    resync = null;
    emit('thread');
    emit('messages');
    emit('composer');
    buffered.forEach(handleEvent);
  }
  if (state.ui.panel.open) refreshChanges();
}

export function newThread({ workspace } = {}) {
  state.activeId = null;
  state.session = null;
  state.messages = [];
  if (workspace) state.workspace = workspace;
  state.changes = null;
  emit('thread');
  emit('messages');
  emit('composer');
  if (state.ui.panel.open) refreshChanges();
}

export async function deleteSession(id) {
  await api(`/api/sessions/${id}`, { method: 'DELETE' });
  if (state.activeId === id) newThread();
  loadSessions();
}

// --------------------------------------------------------------------------
// Envío
// --------------------------------------------------------------------------
let socket = null;

export function sendMessage(prompt, attachments = []) {
  if (!prompt.trim() && !attachments.length) return false;
  if (state.running) return false;
  const ok = socket?.send({
    type: 'run_task',
    prompt: prompt.trim() || 'Revisa los archivos adjuntos.',
    attachments,
    workspace: activeWorkspace() || undefined,
    sessionId: state.activeId,
    permissionMode: state.prefs.mode,
    model: currentModelId(),
    effort: effectiveEffort(),
    incognito: false
  });
  if (!ok) toast('Sin conexión con el servidor', 'error');
  else state.sending = true;
  return ok;
}

export function effectiveEffort() {
  const levels = effortLevelsFor(currentModelId());
  return state.prefs.effort !== 'auto' && levels.includes(state.prefs.effort) ? state.prefs.effort : null;
}

export function cancelTask() {
  socket?.send({ type: 'cancel_task' });
}

export function respondPermission(id, allow, always = false) {
  socket?.send({ type: 'permission_response', id, allow, always });
  state.perms.delete(id);
  emit('perms');
}

// --------------------------------------------------------------------------
// Eventos del servidor
// --------------------------------------------------------------------------
const STREAM = new Set(['stream_delta', 'stream_raw', 'stream_thinking', 'tool_use', 'tool_result']);
let sessionsTimer = null;

const liveMessage = () => {
  for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].role === 'assistant' && state.messages[i].status === 'running') return state.messages[i];
  return null;
};

function notifyDesktop(title, body, sessionId) {
  if (document.hasFocus() || !('Notification' in window)) return;
  try {
    const n = new Notification(title, { body, tag: sessionId ? `task-${sessionId}` : undefined });
    n.onclick = () => { window.Zer0CodeDesktop?.focus?.(); if (sessionId) openSession(sessionId); };
  } catch { /* sin avisos del sistema */ }
}

const plain = (t) => String(t || '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function handleEvent(data) {
  if (STREAM.has(data.type)) {
    if (resync) { resync.push(data); return; }
    if (data.sessionId && data.sessionId !== state.activeId) return;
    if (data.seq) {
      if (data.seq <= lastSeq) return;
      lastSeq = data.seq;
    }
  }

  switch (data.type) {
    case 'auth_success': {
      if (data.user) state.user = data.user;
      state.perms = new Map((data.pendingPermissions || []).map(p => [p.id, p]));
      emit('perms');
      if (data.liveTask) {
        state.running = true;
        state.liveSessionId = data.liveTask.sessionId;
        if (state.activeId === data.liveTask.sessionId) openSession(state.activeId);
        else if (!state.activeId && !state.messages.length) openSession(data.liveTask.sessionId);
      } else if (state.running) {
        state.running = false;
        if (state.activeId) openSession(state.activeId);
      }
      emit('running');
      loadSessions();
      break;
    }

    case 'sessions_changed':
      clearTimeout(sessionsTimer);
      sessionsTimer = setTimeout(async () => {
        await loadSessions().catch(() => {});
        if (state.activeId && !state.running && !state.sessions.some(s => s.id === state.activeId)) {
          newThread();
          toast('Esta conversación se eliminó en otro dispositivo');
        }
      }, 250);
      break;

    case 'user_message':
      if (data.sessionId === state.activeId || (!state.activeId && state.sending)) {
        if (!state.messages.some(m => m.id === data.message.id)) {
          state.messages.push(data.message);
          emit('messages');
        }
      }
      break;

    case 'assistant_start':
      state.sending = false;
      lastSeq = 0;
      state.running = true;
      state.phase = null;
      state.liveSessionId = data.sessionId;
      if (!state.activeId) {
        state.activeId = data.sessionId;
        state.session = { id: data.sessionId, workspace: data.message.workspace || activeWorkspace(), title: 'Nueva conversación' };
        emit('thread');
      }
      if (data.sessionId === state.activeId && !state.messages.some(m => m.id === data.message.id)) {
        state.messages.push({ ...data.message });
        emit('messages');
      }
      emit('running');
      emit('sessions');
      break;

    case 'stream_delta':
    case 'stream_raw': {
      const m = liveMessage();
      if (m) { m.text = (m.text || '') + data.text + (data.type === 'stream_raw' ? '\n' : ''); emit('msg', m); }
      break;
    }
    case 'stream_thinking': {
      const m = liveMessage();
      if (m) { m.thinking = (m.thinking || '') + data.thinking; emit('msg', m); }
      break;
    }
    case 'tool_use': {
      const m = liveMessage();
      if (m && !data.subagent) {
        (m.tools ||= []).push({ id: data.id, tool: data.tool, input: data.input, status: 'running', time: Date.now() });
        emit('msg', m);
      }
      break;
    }
    case 'tool_result': {
      const m = liveMessage();
      const t = m?.tools?.find(x => x.id === data.id);
      if (t) { t.status = data.isError ? 'error' : 'done'; if (data.isError) t.error = data.content; emit('msg', m); }
      break;
    }

    case 'review_update': {
      if (data.sessionId !== state.activeId) break;
      const m = state.messages.find(x => x.id === data.messageId);
      if (!m) break;
      m.reviews ||= [];
      const i = m.reviews.findIndex(r => r.id === data.review.id);
      if (i >= 0) m.reviews[i] = data.review;
      else m.reviews.push(data.review);
      emit('msg', m);
      if (state.ui.panel.open && data.review.status !== 'running') refreshChanges();
      break;
    }

    case 'task_phase':
      state.phase = data.phase;
      emit('running');
      break;

    case 'task_completed':
    case 'task_error': {
      state.sending = false;
      const failed = data.type === 'task_error';
      const message = data.message;
      if (data.sessionId === state.activeId && message) {
        const i = state.messages.findIndex(m => m.id === message.id);
        if (i >= 0) state.messages[i] = message;
        else if (message.role === 'assistant') state.messages.push(message);
        emit('messages');
      } else if (data.sessionId) {
        state.unread.add(data.sessionId);
      }
      state.running = false;
      state.phase = null;
      emit('running');
      emit('sessions');
      loadSessions().catch(() => {});
      loadGitSummary(message?.workspace || activeWorkspace(), { force: true });
      if (state.ui.panel.open) refreshChanges();
      const flagged = (message?.reviews || []).some(r => r.verdict === 'CAMBIOS');
      notifyDesktop(failed ? 'La tarea ha fallado' : 'Zer0 ha terminado', failed ? String(message?.error || '') : `${flagged ? 'El revisor propone cambios. ' : ''}${plain(message?.text)}`, data.sessionId);
      break;
    }

    case 'task_canceled':
      state.running = false;
      state.phase = null;
      emit('running');
      if (state.activeId) setTimeout(() => state.activeId && !state.running && openSession(state.activeId), 900);
      break;

    case 'permission_request':
      if (data.request) {
        state.perms.set(data.request.id, data.request);
        emit('perms');
        notifyDesktop('Zer0 necesita permiso', data.request.tool, data.request.sessionId);
      }
      break;

    case 'permission_resolved':
      state.perms.delete(data.id);
      emit('perms');
      break;

    case 'orchestration_updated':
      state.orch = data;
      emit('orch');
      break;

    case 'models_updated':
      state.models = data.models || state.models;
      state.defaultModel = data.defaultModel || state.defaultModel;
      emit('composer');
      break;

    case 'user_updated':
      if (data.user) state.user = data.user;
      break;

    case 'auth_error':
      auth.clear();
      emit('logout');
      break;
  }
}

// --------------------------------------------------------------------------
// Arranque y sesión
// --------------------------------------------------------------------------
export async function login(username, password) {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json().catch(() => ({}));
  if (data.success) auth.set(data.token, data.username);
  return data;
}

export async function changePassword(currentPassword, newPassword) {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return res.json().catch(() => ({}));
}

export async function verifySession() {
  if (!auth.token) return { ok: false };
  const res = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${auth.token}` } }).catch(() => null);
  if (!res) return { ok: false, offline: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return { ok: false };
  if (state.user?.username !== data.user?.username) state.profile = null;
  state.user = data.user || null;
  return { ok: true, mustChangePassword: data.mustChangePassword };
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  socket?.close();
  auth.clear();
  state.profile = null;
  state.user = null;
  emit('logout');
}

// --------------------------------------------------------------------------
// Actualizaciones de la app de escritorio (releases de GitHub; las gestiona el proceso principal)
// --------------------------------------------------------------------------
let updateToasted = '';
function setUpdate(st) {
  const was = state.update?.status;
  state.update = st;
  emit('update');
  if (st?.status === 'available' && st.latest && updateToasted !== st.latest.version && was !== 'available') {
    updateToasted = st.latest.version;
    toast(`Hay una versión nueva: Zer0Code ${st.latest.version}`);
  }
  // Recién actualizada (o la actualización no llegó a aplicarse): la interfaz enseña las novedades o el aviso
  if (st?.justUpdated) emit('just-updated', st.justUpdated);
}

export function initUpdates() {
  const bridge = window.Zer0CodeDesktop;
  if (!bridge?.getUpdate) return;
  bridge.getUpdate().then(setUpdate).catch(() => {});
  bridge.onUpdate(setUpdate);
}

// Novedades: las pide el proceso principal; una app de escritorio anterior no sabe, y se piden a GitHub directamente
async function fetchReleases() {
  const bridge = window.Zer0CodeDesktop;
  if (bridge?.getReleases) return bridge.getReleases();
  const res = await fetch('https://api.github.com/repos/Zer0Dev-exe/Zer0Code/releases?per_page=15', { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  return (await res.json())
    .filter(r => !r.draft && /^v?\d+\.\d+\.\d+/.test(r.tag_name || ''))
    .map(r => ({ version: r.tag_name.replace(/^v/i, ''), name: r.name || r.tag_name, date: r.published_at, notes: String(r.body || '').trim(), url: r.html_url, prerelease: !!r.prerelease }));
}

export const updateActions = {
  check: () => window.Zer0CodeDesktop?.checkUpdate?.().then(setUpdate),
  install: () => window.Zer0CodeDesktop?.installUpdate?.(),
  skip: (version) => window.Zer0CodeDesktop?.skipUpdate?.(version),
  releases: fetchReleases,
  dismissNotice: () => { if (state.update) state.update = { ...state.update, justUpdated: null }; return window.Zer0CodeDesktop?.dismissUpdateNotice?.(); }
};

export async function startSession() {
  initUpdates();
  await Promise.all([loadStatus(), loadOrchestration()]);
  await loadSessions();
  socket = connectSocket({
    onMessage: handleEvent,
    onState: (s) => { state.conn = s; emit('conn'); if (s === 'unauthorized') { auth.clear(); emit('logout'); } }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadSessions().catch(() => {}); });
}
