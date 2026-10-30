import { renderMarkdown, escapeHtml } from './markdown.js';

// ==========================================================================
// Zer0Code - Cliente web propio con Auth .env e Historial
// ==========================================================================

let authToken = localStorage.getItem('zer0code_token') || null;
let currentUsername = localStorage.getItem('zer0code_user') || 'admin';
// Rol, modos y carpetas permitidas del usuario (los envía el servidor)
let currentUser = null;
let identityProfile = null;
let providerUsageData = null;
let ws = null;
let currentWorkspace = '';
let activeSessionId = null;
let isRunning = false;

let currentAssistantElement = null;
let currentTextElement = null;
let currentThinkingElement = null;
let currentAccumulatedText = '';
let currentAccumulatedThinking = '';
// Texto del bloque visible actual (se reinicia tras cada herramienta para intercalar texto y acciones)
let currentSegmentText = '';
const currentToolCards = new Map();
// Respuesta en curso recuperada del servidor: lastTaskSeq descarta eventos ya incluidos en la
// instantánea y resyncBuffer guarda los que llegan mientras se descarga
let lastTaskSeq = 0;
let resyncBuffer = null;

let recognition = null;
let isListening = false;
let browsingDirectory = '';

// Preferencias del usuario (solo en este navegador)
function readPref(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // almacenamiento no disponible: la preferencia dura solo esta sesión
  }
}

let selectedEffort = readPref('zer0code_effort', 'auto');
let selectedOutputStyle = readPref('zer0code_output_style', 'default');
let incognitoMode = false;
let incognitoSessionId = null;
let sessionFilter = '';
let lastSessionsList = [];

// DOM Elements: Auth
const loginScreen = document.getElementById('login-screen');
const mainApp = document.getElementById('main-app');
const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const btnLogout = document.getElementById('btn-logout');
const userDisplayName = document.getElementById('user-display-name');
const userAvatarLetter = document.getElementById('user-avatar-letter');

// DOM Elements: Sidebar & History
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const btnHamburger = document.getElementById('btn-hamburger');
const btnNewChat = document.getElementById('btn-new-chat');
const sessionsList = document.getElementById('sessions-list');
const sidebarWsName = document.getElementById('sidebar-ws-name');
const btnChangeWs = document.getElementById('btn-change-ws');

// DOM Elements: Main Chat
const topChatTitle = document.getElementById('top-chat-title');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const chatViewport = document.getElementById('chat-viewport');
const emptyState = document.getElementById('empty-state');
const messagesContainer = document.getElementById('messages-container');
const promptInput = document.getElementById('prompt-input');
const btnSend = document.getElementById('btn-send');
const btnStop = document.getElementById('btn-stop');
const btnVoice = document.getElementById('btn-voice');
const btnAttach = document.getElementById('btn-attach');
const attachInput = document.getElementById('attach-input');
const attachPreview = document.getElementById('attach-preview');
const inputWsPill = document.getElementById('input-ws-pill');
const inputWsName = document.getElementById('input-ws-name');
const permissionMode = document.getElementById('permission-mode');

// DOM Elements: Model & Mode Custom Dropdowns
const dropdownModel = document.getElementById('dropdown-model');
const btnModelTrigger = document.getElementById('btn-model-trigger');
const currentModelName = document.getElementById('current-model-name');
const currentModelTag = document.getElementById('current-model-tag');
const menuModelOptions = document.getElementById('menu-model-options');
const dynamicModelList = document.getElementById('dynamic-model-list');
const btnOpenAddModel = document.getElementById('btn-open-add-model');
const btnSyncModels = document.getElementById('btn-sync-models');

const dropdownMode = document.getElementById('dropdown-mode');
const btnModeTrigger = document.getElementById('btn-mode-trigger');
const currentModeIcon = document.getElementById('current-mode-icon');
const currentModeLabel = document.getElementById('current-mode-label');
const menuModeOptions = document.getElementById('menu-mode-options');

// DOM Elements: Custom Model Modal
const customModelModal = document.getElementById('custom-model-modal');
const btnCloseCustomModelModal = document.getElementById('btn-close-custom-model-modal');
const btnCancelCustomModelModal = document.getElementById('btn-cancel-custom-model-modal');
const btnSaveCustomModel = document.getElementById('btn-save-custom-model');
const customModelIdInput = document.getElementById('custom-model-id');
const customModelNameInput = document.getElementById('custom-model-name-input');
const customModelTagInput = document.getElementById('custom-model-tag-input');
const customModelDescInput = document.getElementById('custom-model-desc-input');
const customModelStatus = document.getElementById('custom-model-status');

// DOM Elements: Slash Commands Popover
const slashPopup = document.getElementById('slash-popup');
const slashPopupList = document.getElementById('slash-popup-list');
let highlightedSlashIndex = -1;
let currentSlashMatches = [];

// Dynamic Models Catalog
let availableModelsList = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tag: 'Máximo', desc: 'Para tus desafíos más difíciles' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tag: 'Profundo', desc: 'El más capaz para trabajos ambiciosos', default: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tag: 'Equilibrado', desc: 'Lo más eficiente para las tareas diarias' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tag: 'Ultrarrápido', desc: 'La más rápida para respuestas inmediatas' }
];
const DEFAULT_MODEL_ID = 'claude-opus-5-5';
let availableModelsMap = {};
// Cuentas de ChatGPT (Codex) y Gemini conectadas en el servidor
let providersStatus = {};
const PROVIDER_LABELS = { codex: 'ChatGPT', gemini: 'Gemini' };

function rebuildModelsMap() {
  availableModelsMap = {};
  availableModelsList.forEach(m => {
    availableModelsMap[m.id] = m;
    const lower = m.id.toLowerCase();
    // Los alias genéricos apuntan al primer (más reciente) modelo de cada familia
    if (lower.includes('sonnet') && !availableModelsMap['sonnet']) availableModelsMap['sonnet'] = m;
    if (lower.includes('haiku') && !availableModelsMap['haiku']) availableModelsMap['haiku'] = m;
    if (lower.includes('opus') && !availableModelsMap['opus']) availableModelsMap['opus'] = m;
    if (lower.includes('fable') && !availableModelsMap['fable']) availableModelsMap['fable'] = m;
  });
}
rebuildModelsMap();

function getModelInfo(id) {
  if (!id) return availableModelsList[0];
  if (availableModelsMap[id]) return availableModelsMap[id];
  const lower = String(id).toLowerCase();
  for (const m of availableModelsList) {
    if (m.id.toLowerCase() === lower || m.id.toLowerCase().includes(lower)) {
      return m;
    }
  }
  return { id, name: id, tag: 'Custom', desc: 'Modelo personalizado' };
}

const EXECUTION_MODES = {
  'acceptEdits': {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>`,
    label: 'Aceptar ediciones'
  },
  'auto': {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
    label: 'Autónomo'
  },
  'manual': {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
    label: 'Manual'
  },
  'plan': {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><line x1="9" y1="11" x2="15" y2="11"></line><line x1="9" y1="16" x2="13" y2="16"></line></svg>`,
    label: 'Modo Plan'
  }
};

// Descartar selecciones guardadas de modelos retirados (Claude 3.x)
function sanitizeStoredModel(id) {
  if (!id || /^claude-3/i.test(id)) return DEFAULT_MODEL_ID;
  // Alias genéricos antiguos ('sonnet', 'opus'...) -> ID concreto del modelo actual
  if (availableModelsMap[id] && availableModelsMap[id].id !== id) return availableModelsMap[id].id;
  return id;
}

let selectedModel = sanitizeStoredModel(localStorage.getItem('zer0code_model'));

// DOM Elements: Workspace Modal
const workspaceModal = document.getElementById('workspace-modal');
const btnOpenWorkspace = document.getElementById('btn-open-workspace');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelWorkspace = document.getElementById('btn-cancel-workspace');
const btnSelectWorkspace = document.getElementById('btn-select-workspace');
const customDirInput = document.getElementById('custom-dir-input');
const btnDirGo = document.getElementById('btn-dir-go');
const btnDirUp = document.getElementById('btn-dir-up');
const quickLocationsList = document.getElementById('quick-locations-list');
const foldersList = document.getElementById('folders-list');
const newFolderName = document.getElementById('new-folder-name');
const btnCreateFolder = document.getElementById('btn-create-folder');

// DOM Elements: Modo Hoster/Client & Key Modal
let appMode = 'Hoster';
let clientApiKey = localStorage.getItem('zer0code_client_key') || '';
let serverAuthInfo = null;

const btnModeIndicator = document.getElementById('btn-mode-indicator');
const modePillDot = document.getElementById('mode-pill-dot');
const modePillText = document.getElementById('mode-pill-text');
const btnSidebarKey = document.getElementById('btn-sidebar-key');
const btnSidebarUserPill = document.getElementById('btn-sidebar-user-pill');

const keyModal = document.getElementById('key-modal');
const btnCloseKeyModal = document.getElementById('btn-close-key-modal');
const btnCancelKeyModal = document.getElementById('btn-cancel-key-modal');
const btnSaveKeyModal = document.getElementById('btn-save-key-modal');
const keyModalModeBadge = document.getElementById('key-modal-mode-badge');
const keyModalModeStatus = document.getElementById('key-modal-mode-status');
const keyModalModeDesc = document.getElementById('key-modal-mode-desc');
const clientApiKeyInput = document.getElementById('client-api-key-input');
const btnToggleKeyVis = document.getElementById('btn-toggle-key-vis');
const keyValidationStatus = document.getElementById('key-validation-status');
const btnTestKey = document.getElementById('btn-test-key');
const btnDeleteKey = document.getElementById('btn-delete-key');
const emptySubtext = document.querySelector('.empty-subtext');

// ==========================================================================
// 1. Autenticación (.env)
// ==========================================================================
async function checkAuth() {
  if (!authToken) {
    showLogin();
    return;
  }

  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = res.ok ? await res.json() : null;
    if (data && data.success && !data.mustChangePassword) {
      if (data.username) setCurrentUsername(data.username);
      if (data.user) currentUser = data.user;
      showApp();
    } else {
      // Sin sesión, o hay que cambiar la contraseña por defecto (para eso se pide volver a entrar)
      clearAuthToken();
      showLogin();
    }
  } catch (err) {
    console.warn('Error verificando auth:', err);
    showLogin();
  }
}

// Contraseña recién introducida, solo mientras se obliga a cambiar la de por defecto
let pendingLoginPassword = null;

function setCurrentUsername(name) {
  if (name !== currentUsername) identityProfile = null;
  currentUsername = name;
  localStorage.setItem('zer0code_user', name);
}

function clearAuthToken() {
  localStorage.removeItem('zer0code_token');
  authToken = null;
  identityProfile = null;
  providerUsageData = null;
}

function showLogin() {
  document.documentElement.classList.remove('auth-pending');
  pendingLoginPassword = null;
  document.getElementById('login-card').hidden = false;
  document.getElementById('force-password-card').hidden = true;
  loginScreen.style.display = 'flex';
  mainApp.style.display = 'none';
}

function showForcePasswordChange() {
  document.getElementById('login-card').hidden = true;
  document.getElementById('force-password-card').hidden = false;
  document.getElementById('force-password-user').value = currentUsername;
  document.getElementById('force-password-error').style.display = 'none';
  loginScreen.style.display = 'flex';
  mainApp.style.display = 'none';
  document.getElementById('force-password-new').focus();
}

async function requestPasswordChange(currentPassword, newPassword) {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return res.json();
}

document.getElementById('force-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById('force-password-error');
  const next = document.getElementById('force-password-new').value;
  const confirm = document.getElementById('force-password-confirm').value;
  errorBox.style.display = 'none';

  if (next !== confirm) {
    errorBox.textContent = 'Las contraseñas no coinciden';
    errorBox.style.display = 'block';
    return;
  }
  if (!pendingLoginPassword) {
    showLogin();
    return;
  }

  try {
    const data = await requestPasswordChange(pendingLoginPassword, next);
    if (data.success) {
      pendingLoginPassword = null;
      e.target.reset();
      showApp();
      showToast('Contraseña actualizada');
    } else {
      errorBox.textContent = data.message || 'No se pudo cambiar la contraseña';
      errorBox.style.display = 'block';
    }
  } catch (err) {
    errorBox.textContent = 'Error al conectar con el servidor';
    errorBox.style.display = 'block';
  }
});

function showApp() {
  document.documentElement.classList.remove('auth-pending');
  loginScreen.style.display = 'none';
  mainApp.style.display = 'flex';
  userDisplayName.textContent = currentUsername;
  userAvatarLetter.textContent = currentUsername.charAt(0).toUpperCase();

  initApp();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.style.display = 'none';

  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success) {
      authToken = data.token;
      setCurrentUsername(data.username);
      localStorage.setItem('zer0code_token', authToken);
      loginPassword.value = '';
      if (data.mustChangePassword) {
        pendingLoginPassword = password;
        showForcePasswordChange();
      } else {
        showApp();
      }
    } else {
      loginError.textContent = data.message || 'Usuario o contraseña incorrectos';
      loginError.style.display = 'block';
    }
  } catch (err) {
    loginError.textContent = 'Error al conectar con el servidor';
    loginError.style.display = 'block';
  }
});

btnLogout.addEventListener('click', async () => {
  // Este dispositivo deja de recibir avisos de la cuenta que cierra sesión
  await disablePush().catch(() => {});
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
  } catch (e) {}

  clearAuthToken();
  showLogin();
});

// Helper for authenticated fetch
// --- Imágenes dentro del chat ------------------------------------------------
// Claude las enseña con ![texto](ruta). Una ruta local no se puede pedir con <img> (hace falta el
// token), así que se descarga con sesión y se sustituye por un blob.
const chatImageCache = new Map();

function localImagePath(img) {
  const src = img.getAttribute('src') || '';
  if (!src || /^(https?:|data:|blob:|\/\/)/i.test(src) || img.dataset.localImage) return null;
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(src.split(/[?#]/)[0])) return null;
  try { return decodeURIComponent(src.replace(/^file:\/\//, '')); } catch { return src; }
}

async function loadChatImage(path) {
  const key = `${currentWorkspace}\n${path}`;
  if (!chatImageCache.has(key)) {
    chatImageCache.set(key, authFetch(`/api/files/image?path=${encodeURIComponent(path)}&workspace=${encodeURIComponent(currentWorkspace || '')}`)
      .then(res => res.ok ? res.blob() : Promise.reject(new Error('no disponible')))
      .then(blob => URL.createObjectURL(blob)));
  }
  return chatImageCache.get(key);
}

async function hydrateChatImage(img) {
  const path = localImagePath(img);
  if (!path) return;
  img.dataset.localImage = path;
  img.removeAttribute('src');
  img.classList.add('chat-image', 'is-loading');
  try {
    const url = await loadChatImage(path);
    img.src = url;
    img.classList.remove('is-loading');
    img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  } catch {
    chatImageCache.delete(`${currentWorkspace}\n${path}`);
    img.classList.remove('is-loading');
    img.classList.add('is-missing');
    img.alt = `${img.alt || 'Imagen'} (no disponible)`;
  }
}

new MutationObserver(mutations => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'IMG') hydrateChatImage(node);
      else node.querySelectorAll?.('img').forEach(hydrateChatImage);
    });
  }
}).observe(messagesContainer, { childList: true, subtree: true });

async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${authToken}`;
  if (clientApiKey) {
    options.headers['x-claude-api-key'] = clientApiKey;
  }
  const res = await fetch(url, options);
  // 403 también llega cuando un usuario sin permisos de admin intenta algo: solo se sale si hay que cambiar la contraseña
  const mustRelogin = res.status === 401
    || (res.status === 403 && (await res.clone().json().catch(() => ({}))).mustChangePassword);
  if (mustRelogin) {
    clearAuthToken();
    showLogin();
    throw new Error('No autorizado');
  }
  return res;
}

// ==========================================================================
// 2. Inicialización de la Aplicación
// ==========================================================================
function initApp() {
  loadGlobalProfile();
  loadProviderUsage();
  initModelAndMode();
  loadModels().then(syncModelsSilently);
  connectWebSocket();
  loadInitialStatus();
  loadPlanLimits();
  loadSessions();
  setupVoice();
  setupEventListeners();
  setupShell();
  setupAppInstall();
  // Abierta desde una notificación: ir a esa conversación
  const fromNotification = new URLSearchParams(location.search).get('session');
  if (fromNotification) {
    history.replaceState(null, '', '/');
    openSession(fromNotification);
  }
}

let reconnectTimer = null;

// Al volver a la app (el móvil corta el WebSocket en segundo plano) reconectar sin esperar
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  // El servidor solo envía notificaciones push mientras la app no está a la vista
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'visibility', visible }));
  if (visible) clearShownNotifications();
  if (!visible || !authToken || !ws) return;
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    clearTimeout(reconnectTimer);
    connectWebSocket();
  }
});

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // El token se envía en el primer mensaje (onopen), no en la URL
  const wsUrl = `${protocol}//${window.location.host}`;

  if (statusIndicator) statusIndicator.className = 'status-indicator';
  if (statusText) statusText.textContent = 'Conectando...';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (statusIndicator) statusIndicator.className = 'status-indicator';
    if (statusText) statusText.textContent = 'Conectado';
    ws.send(JSON.stringify({ type: 'auth', token: authToken, visible: document.visibilityState === 'visible' }));
  };

  ws.onclose = (event) => {
    if (statusIndicator) statusIndicator.className = 'status-indicator';
    if (statusText) statusText.textContent = 'Desconectado';
    if (btnModelTrigger) btnModelTrigger.classList.remove('working');
    // 4001: el servidor ha cerrado esta sesión (cambio de contraseña o «cerrar en todos»)
    if (event.code === 4001) {
      clearAuthToken();
      showLogin();
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (authToken) connectWebSocket();
    }, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (e) {
      console.error('Error parseando mensaje WS:', e);
    }
  };
}

async function loadInitialStatus() {
  try {
    const res = await authFetch('/api/status');
    const data = await res.json();
    if (data.user) applyCurrentUser(data.user);
    if (data.auth) {
      serverAuthInfo = data.auth;
    }
    if (data.providers) providersStatus = data.providers;
    if (data.appMode) {
      appMode = data.appMode;
      updateModeUI();
    }
    if (data.currentWorkspace) {
      updateWorkspaceUI(data.currentWorkspace);
    }
    if (data.availableModels && Array.isArray(data.availableModels)) {
      applyModelsList(data.availableModels, data.defaultModel);
    }
  } catch (e) {}
}

async function loadModels() {
  try {
    const res = await authFetch('/api/models');
    const data = await res.json();
    if (data.success && Array.isArray(data.models)) {
      applyModelsList(data.models, data.defaultModel);
    }
  } catch (err) {
    console.warn('Error cargando modelos:', err);
  }
}

// Aplicar un catálogo nuevo; si el modelo seleccionado ya no existe, pasar al por defecto
function applyModelsList(models, defaultModel) {
  if (!Array.isArray(models) || models.length === 0) return;
  availableModelsList = models;
  rebuildModelsMap();
  if (!availableModelsList.some(m => m.id === selectedModel)) {
    const fallback = availableModelsList.find(m => m.id === defaultModel)
      || availableModelsList.find(m => m.isDefault)
      || availableModelsList[0];
    setModel(fallback.id, fallback.name, fallback.tag);
  }
  renderModelDropdown();
}

// Consultar a Anthropic los modelos actuales al abrir la app (sin avisos si falla)
async function syncModelsSilently() {
  try {
    const res = await authFetch('/api/models/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) applyModelsList(data.models, data.defaultModel);
  } catch (err) {
    console.warn('No se pudo sincronizar modelos con Anthropic:', err);
  }
}

function updateModeUI() {
  if (appMode === 'Client') {
    if (btnModeIndicator && modePillText && modePillDot) {
      if (clientApiKey) {
        btnModeIndicator.className = 'mode-pill-btn client-ready';
        modePillText.textContent = 'Mi Key lista';
        btnModeIndicator.title = 'Modo Cliente: Tu clave personal de Claude está configurada (Clic para ver/cambiar)';
      } else {
        btnModeIndicator.className = 'mode-pill-btn client-missing';
        modePillText.textContent = 'Configurar Key';
        btnModeIndicator.title = 'Modo Cliente: Falta tu clave de Claude (Clic para configurar)';
      }
    }
    if (emptySubtext) {
      emptySubtext.textContent = clientApiKey
        ? 'Modo Cliente: Tu agente está ejecutándose con tu propia clave personal de Claude.'
        : 'Modo Cliente: Configura tu API Key de Claude para comenzar a interactuar.';
    }
  } else {
    // Hoster mode
    const isHostLoggedIn = serverAuthInfo && serverAuthInfo.loggedIn;
    if (btnModeIndicator && modePillText && modePillDot) {
      if (isHostLoggedIn || clientApiKey) {
        btnModeIndicator.className = 'mode-pill-btn hoster';
        modePillText.textContent = clientApiKey ? 'Key Propia' : 'Modo Hoster';
        btnModeIndicator.title = isHostLoggedIn
          ? `Modo Hoster: Cuenta activa (${serverAuthInfo.email || 'Compartida'})`
          : 'Modo Hoster: Usando clave personal';
      } else {
        btnModeIndicator.className = 'mode-pill-btn client-missing';
        modePillText.textContent = 'Vincular Claude';
        btnModeIndicator.title = 'Modo Hoster: El anfitrión aún no ha iniciado sesión. Clic para ver instrucciones.';
      }
    }
    if (emptySubtext) {
      emptySubtext.textContent = isHostLoggedIn
        ? `Modo Hoster: Conectado a la cuenta compartida de Claude (${serverAuthInfo.email || 'Plan Pro'}).`
        : 'Modo Hoster: El anfitrión debe vincular su cuenta con "pnpm auth:login" o definir ANTHROPIC_API_KEY en .env.';
    }
  }
  if (shellReady) updateUserIdentity();
}

function updateWorkspaceUI(wsPath) {
  currentWorkspace = wsPath;
  sidebarWsName.textContent = wsPath;
  const parts = wsPath.split(/[\\/]/).filter(Boolean);
  const shortName = parts.length > 0 ? parts[parts.length - 1] : wsPath;
  inputWsName.textContent = shortName;
  if (inputWsPill) inputWsPill.title = `Carpeta activa: ${wsPath} (clic para cambiar)`;
}

// ==========================================================================
// 3. Historial de Sesiones & Conversaciones
// ==========================================================================
async function loadSessions() {
  try {
    const res = await authFetch('/api/sessions');
    const data = await res.json();
    renderSessionsList(data.sessions || []);
  } catch (e) {
    sessionsList.innerHTML = '<div class="sessions-loading">Error al cargar chats</div>';
  }
}

function renderSessionsList(sessions) {
  lastSessionsList = sessions;
  sessionsList.innerHTML = '';
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="sessions-loading">Sin conversaciones previas</div>';
    return;
  }

  const query = sessionFilter.trim().toLowerCase();
  const visible = query ? sessions.filter(s => (s.title || '').toLowerCase().includes(query)) : sessions;
  if (visible.length === 0) {
    sessionsList.innerHTML = '<div class="sessions-loading">Ninguna conversación coincide</div>';
    return;
  }

  visible.forEach(sess => {
    const item = document.createElement('div');
    item.className = 'session-item' + (sess.id === activeSessionId ? ' active' : '');
    item.innerHTML = `
      <span class="session-title-text" title="${escapeHtml(sess.title)}">${escapeHtml(sess.title)}</span>
      <button class="session-del-btn" title="Eliminar chat" aria-label="Eliminar chat" data-id="${sess.id}">
        <svg><use href="#i-trash"/></svg>
      </button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.session-del-btn')) return;
      openSession(sess.id);
    });

    const delBtn = item.querySelector('.session-del-btn');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`¿Eliminar la conversación "${sess.title}"?`)) {
        await deleteSession(sess.id);
      }
    });

    sessionsList.appendChild(item);
  });
  if (shellReady) updateTopTitle();
}

async function openSession(id) {
  if (incognitoMode) setIncognito(false);
  resyncBuffer = [];
  try {
    const res = await authFetch(`/api/sessions/${id}`);
    const data = await res.json();
    if (data.session) {
      activeSessionId = data.session.id;
      topChatTitle.textContent = data.session.title;
      currentAssistantElement = null;
      renderMessages(data.session.messages || []);
      if (data.liveTask) resumeLiveTask(data.liveTask);
      loadSessions();
      closeMobileSidebar();
    }
  } catch (err) {
    console.error('Error cargando sesión:', err);
  } finally {
    // Aplicar los eventos que llegaron durante la descarga (los ya incluidos se descartan por seq)
    const buffered = resyncBuffer || [];
    resyncBuffer = null;
    buffered.forEach(handleWsMessage);
  }
}

// Seguir pintando una respuesta que el servidor continuó generando mientras la web estaba cerrada
function resumeLiveTask(live) {
  const msg = live.message || {};
  startStreamingAssistant();
  lastTaskSeq = live.seq || 0;
  const bubble = currentAssistantElement.querySelector('.msg-bubble');
  for (const t of msg.tools || []) {
    if (t.subagent) continue;
    const card = buildToolCard(t);
    bubble.insertBefore(card, currentTextElement);
    if (t.status === 'running' && t.id) currentToolCards.set(t.id, card);
  }
  if (msg.thinking) {
    currentAccumulatedThinking = msg.thinking;
    currentThinkingElement.style.display = 'block';
    currentThinkingElement.querySelector('.thinking-content').textContent = msg.thinking;
  }
  currentAccumulatedText = msg.text || '';
  currentSegmentText = currentAccumulatedText;
  if (currentSegmentText.trim()) {
    currentTextElement.innerHTML = renderMarkdown(currentSegmentText);
  }
  setRunning(true);
  scrollToBottom();
}

async function deleteSession(id) {
  try {
    await authFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (activeSessionId === id) {
      newChat();
    } else {
      loadSessions();
    }
  } catch (e) {}
}

function newChat() {
  discardIncognitoSession();
  activeSessionId = null;
  topChatTitle.textContent = 'Nueva conversación';
  messagesContainer.innerHTML = '';
  emptyState.style.display = 'block';
  loadSessions();
  closeMobileSidebar();
}

// ==========================================================================
// 4. Renderizado de Mensajes
// ==========================================================================
function renderMessages(messages) {
  messagesContainer.innerHTML = '';
  if (!messages || messages.length === 0) {
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  messages.forEach(msg => {
    if (msg.role === 'user') {
      appendUserMsg(msg.text, (msg.attachments || []).map(name => ({ name })));
    } else if (msg.role === 'assistant') {
      appendAssistantMsgStatic(msg);
    }
  });

  scrollToBottom();
}

function appendUserMsg(text, attachments = []) {
  emptyState.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'msg-row user';
  // Las miniaturas solo existen en memoria (object URLs); al recargar solo queda el nombre
  const attachHtml = attachments.length
    ? `<div class="msg-attachments">${attachments.map(renderAttachChip).join('')}</div>`
    : '';
  const bubbleHtml = text ? `<div class="msg-bubble">${escapeHtml(text)}</div>` : '';
  row.innerHTML = attachHtml + bubbleHtml;
  messagesContainer.appendChild(row);
  scrollToBottom();
}

// ==========================================================================
// Archivos adjuntos (solo en memoria; el servidor los borra al terminar)
// ==========================================================================
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
let pendingAttachments = [];

function renderAttachChip(att, index, removable) {
  const removeBtn = removable === true
    ? `<button type="button" class="attach-remove" data-index="${index}" title="Quitar">×</button>`
    : '';
  if (att.url) {
    return `<div class="attach-chip is-image" title="${escapeHtml(att.name)}"><img src="${att.url}" alt="${escapeHtml(att.name)}">${removeBtn}</div>`;
  }
  return `<div class="attach-chip" title="${escapeHtml(att.name)}">📄 <span class="attach-name">${escapeHtml(att.name)}</span>${removeBtn}</div>`;
}

function renderAttachPreview() {
  attachPreview.innerHTML = pendingAttachments.map((att, i) => renderAttachChip(att, i, true)).join('');
  attachPreview.hidden = pendingAttachments.length === 0;
}

function addAttachments(fileList) {
  for (const file of fileList) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      showToast(`Máximo ${MAX_ATTACHMENTS} archivos por mensaje`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`"${file.name}" supera los 15 MB`);
      continue;
    }
    pendingAttachments.push({
      file,
      name: file.name || `pegado-${Date.now()}.png`,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    });
  }
  renderAttachPreview();
}

function removeAttachment(index) {
  const [removed] = pendingAttachments.splice(index, 1);
  if (removed && removed.url) URL.revokeObjectURL(removed.url);
  renderAttachPreview();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function setupAttachments() {
  btnAttach.addEventListener('click', () => attachInput.click());

  attachInput.addEventListener('change', () => {
    addAttachments(attachInput.files);
    attachInput.value = '';
  });

  attachPreview.addEventListener('click', (e) => {
    const btn = e.target.closest('.attach-remove');
    if (btn) removeAttachment(Number(btn.dataset.index));
  });

  // Pegar imágenes con Ctrl+V
  promptInput.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });

  // Arrastrar y soltar sobre la caja de texto
  const inputCard = promptInput.closest('.input-card');
  inputCard.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      inputCard.classList.add('drag-over');
    }
  });
  inputCard.addEventListener('dragleave', () => inputCard.classList.remove('drag-over'));
  inputCard.addEventListener('drop', (e) => {
    inputCard.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addAttachments(e.dataTransfer.files);
    }
  });
}

function shortPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || String(p || '');
}

/**
 * Describir en lenguaje natural qué está haciendo una herramienta (verbo + objetivo)
 */
function describeTool(tool, input) {
  const i = input || {};
  const trunc = (s, n = 80) => {
    const str = String(s || '').replace(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  switch (tool) {
    case 'Read': return { verb: 'Leyendo', target: shortPath(i.file_path) };
    case 'Write': return { verb: 'Creando', target: shortPath(i.file_path) };
    case 'Edit':
    case 'MultiEdit': return { verb: 'Editando', target: shortPath(i.file_path) };
    case 'NotebookEdit': return { verb: 'Editando notebook', target: shortPath(i.notebook_path) };
    case 'Bash': return { verb: 'Ejecutando', target: trunc(i.description || i.command) };
    case 'Glob': return { verb: 'Buscando archivos', target: trunc(i.pattern) };
    case 'Grep': return { verb: 'Buscando', target: trunc(i.pattern) };
    case 'WebFetch': return { verb: 'Consultando', target: trunc(i.url) };
    case 'WebSearch': return { verb: 'Buscando en la web', target: trunc(i.query) };
    case 'Task':
    case 'Agent': return { verb: 'Lanzando subagente', target: trunc(i.description) };
    case 'TodoWrite': return { verb: 'Actualizando lista de tareas', target: '' };
    default: return { verb: tool || 'Herramienta', target: '' };
  }
}

/**
 * Detalle desplegable de la herramienta: diff para ediciones, comando para Bash, JSON para el resto
 */
function toolDetailHtml(tool, input) {
  const i = input || {};
  if ((tool === 'Edit') && (i.old_string != null || i.new_string != null)) {
    const del = String(i.old_string || '').split('\n').map(l => `<span class="diff-del">- ${escapeHtml(l)}</span>`).join('\n');
    const add = String(i.new_string || '').split('\n').map(l => `<span class="diff-add">+ ${escapeHtml(l)}</span>`).join('\n');
    return `<pre class="claude-tool-body">${del}\n${add}</pre>`;
  }
  if (tool === 'Write' && i.content != null) {
    return `<pre class="claude-tool-body">${escapeHtml(String(i.content).slice(0, 1500))}</pre>`;
  }
  if (tool === 'Bash' && i.command) {
    return `<pre class="claude-tool-body">$ ${escapeHtml(i.command)}</pre>`;
  }
  if (tool === 'TodoWrite' && Array.isArray(i.todos)) {
    const mark = { completed: '✓', in_progress: '▸', pending: '○' };
    return `<pre class="claude-tool-body">${i.todos.map(t => `${mark[t.status] || '○'} ${escapeHtml(t.content || '')}`).join('\n')}</pre>`;
  }
  const str = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input || '');
  return str ? `<pre class="claude-tool-body">${escapeHtml(str.slice(0, 1500))}</pre>` : '';
}

function buildToolCard(t) {
  const { verb, target } = describeTool(t.tool, t.input);
  const card = document.createElement('details');
  card.className = `claude-tool is-${t.status || 'running'}`;
  card.innerHTML = `
    <summary class="claude-tool-name">
      <span class="tool-status"></span>
      <span class="tool-verb">${escapeHtml(verb)}</span>
      ${target ? `<code class="tool-target">${escapeHtml(target)}</code>` : ''}
    </summary>
    ${toolDetailHtml(t.tool, t.input)}
  `;
  return card;
}

function setToolCardStatus(card, status) {
  card.classList.remove('is-running', 'is-done', 'is-error');
  card.classList.add(`is-${status}`);
}

function startStreamingAssistant() {
  emptyState.style.display = 'none';
  currentAccumulatedText = '';
  currentAccumulatedThinking = '';
  currentSegmentText = '';
  currentToolCards.clear();

  const row = document.createElement('div');
  row.className = 'msg-row assistant';

  row.innerHTML = `
    <div class="assistant-head">
      <div class="claude-avatar-mini brand-logo"><svg><use href="#i-logo"/></svg></div>
      <span class="assistant-name">Zer0</span>
    </div>
    <div class="msg-bubble">
      <details class="claude-thinking" style="display: none;">
        <summary>Pensando...</summary>
        <div class="thinking-content" style="margin-top:6px;"></div>
      </details>
      <div class="text-body"><em>Pensando...</em></div>
    </div>
  `;

  messagesContainer.appendChild(row);

  currentAssistantElement = row;
  currentThinkingElement = row.querySelector('.claude-thinking');
  currentTextElement = row.querySelector('.text-body');

  scrollToBottom();
}

function appendAssistantMsgStatic(msg) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';

  let thinkingHtml = '';
  if (msg.thinking) {
    thinkingHtml = `
      <details class="claude-thinking">
        <summary>Razonamiento</summary>
        <div class="thinking-content" style="margin-top:6px;">${escapeHtml(msg.thinking)}</div>
      </details>
    `;
  }

  const renderedContent = renderMarkdown(msg.text || '');

  row.innerHTML = `
    <div class="assistant-head">
      <div class="claude-avatar-mini brand-logo"><svg><use href="#i-logo"/></svg></div>
      <span class="assistant-name">Zer0</span>
    </div>
    <div class="msg-bubble">
      ${thinkingHtml}
      <div class="text-body">${renderedContent}</div>
    </div>
  `;

  if (Array.isArray(msg.tools) && msg.tools.length) {
    const bubble = row.querySelector('.msg-bubble');
    const textBody = row.querySelector('.text-body');
    for (const t of msg.tools) {
      if (t.subagent) continue;
      // Una herramienta que quedó en 'running' en el historial ya no se está ejecutando
      bubble.insertBefore(buildToolCard({ ...t, status: t.status === 'error' ? 'error' : 'done' }), textBody);
    }
  }

  messagesContainer.appendChild(row);
  appendCostFooter(row, msg.cost);
}

function scrollToBottom() {
  chatViewport.scrollTop = chatViewport.scrollHeight;
}

// ==========================================================================
// 5. Envío de Mensajes, Slash Commands y WebSockets
// ==========================================================================
function renderAssistantCard(htmlContent) {
  emptyState.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `
    <div class="assistant-head">
      <div class="claude-avatar-mini brand-logo"><svg><use href="#i-logo"/></svg></div>
      <span class="assistant-name">Zer0</span>
    </div>
    <div class="msg-bubble">
      <div class="text-body">${htmlContent}</div>
    </div>
  `;
  messagesContainer.appendChild(row);
  scrollToBottom();
  return row;
}

function showToast(message) {
  let toast = document.getElementById('claude-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'claude-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 84px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #252422;
      border: 1px solid rgba(204, 120, 92, 0.4);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      color: #f5f4f0;
      padding: 9px 18px;
      border-radius: 20px;
      font-size: 0.82rem;
      font-weight: 500;
      z-index: 10000;
      opacity: 0;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--claude-terracotta); flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>${escapeHtml(message)}</span>`;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3000);
}

// Slash Commands Definition
const SLASH_COMMANDS = [
  {
    name: '/model',
    badge: 'Modelo',
    desc: 'Cambiar o seleccionar modelo de Claude',
    hint: '[alias|id]',
    action: (arg) => handleSlashModel(arg)
  },
  {
    name: '/mode',
    badge: 'Permisos',
    desc: 'Cambiar modo de ejecución (auto, acceptEdits, plan, manual)',
    hint: '[auto|acceptEdits|plan|manual]',
    action: (arg) => handleSlashMode(arg)
  },
  {
    name: '/clear',
    badge: 'Chat',
    desc: 'Reiniciar y limpiar la conversación actual',
    hint: '',
    action: () => newChat()
  },
  {
    name: '/new',
    badge: 'Chat',
    desc: 'Iniciar una nueva conversación',
    hint: '',
    action: () => newChat()
  },
  {
    name: '/key',
    badge: 'Config',
    desc: 'Configurar tu API Key personal de Claude',
    hint: '',
    action: () => openKeyModal()
  },
  {
    name: '/status',
    badge: 'Sistema',
    desc: 'Ver estado del servidor, workspace, modelo y modo',
    hint: '',
    action: () => handleSlashStatus()
  },
  {
    name: '/folder',
    badge: 'Carpeta',
    desc: 'Explorar y cambiar la carpeta de trabajo activa',
    hint: '[ruta]',
    action: (arg) => handleSlashFolder(arg)
  },
  {
    name: '/sync',
    badge: 'Modelos',
    desc: 'Sincronizar modelos disponibles con Anthropic',
    hint: '',
    action: () => handleSlashSync()
  },
  {
    name: '/help',
    badge: 'Ayuda',
    desc: 'Mostrar la lista completa de comandos slash',
    hint: '',
    action: () => handleSlashHelp()
  }
];

function handleSlashModel(arg) {
  if (arg) {
    const lower = arg.toLowerCase();
    const found = availableModelsList.find(m => m.id.toLowerCase() === lower || m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)) || availableModelsMap[lower];
    if (found) {
      setModel(found.id, found.name, found.tag);
      renderAssistantCard(`
        <div class="interactive-card">
          <div class="interactive-card-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L13.7 8.3L20 7L15.8 12L20 17L13.7 15.7L12 22L10.3 15.7L4 17L8.2 12L4 7L10.3 8.3L12 2Z"/></svg>
            <span>Modelo activo actualizado</span>
          </div>
          <div style="font-size:0.86rem; margin-top:4px;">
            Ahora estás usando <strong>${escapeHtml(found.name)}</strong> (${escapeHtml(found.tag || 'IA')}).
          </div>
          <div style="font-size:0.78rem; color:var(--text-subtle); margin-top:4px;">
            ${escapeHtml(found.desc || found.id)}
          </div>
        </div>
      `);
      return;
    }
  }

  // Interactive Card
  const cardId = 'model-card-' + Date.now();
  let buttonsHtml = '';
  availableModelsList.forEach(m => {
    const isAct = selectedModel === m.id || (m.id.includes('sonnet') && selectedModel === 'sonnet') || (m.id.includes('haiku') && selectedModel === 'haiku') || (m.id.includes('opus') && selectedModel === 'opus');
    buttonsHtml += `
      <button type="button" class="interactive-btn ${isAct ? 'active' : ''}" data-model-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}" data-tag="${escapeHtml(m.tag || '')}">
        <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
          <span style="font-weight:600;">${escapeHtml(m.name)}</span>
          <span style="font-size:0.72rem; color:var(--text-subtle);">${escapeHtml(m.desc || m.id)}</span>
        </div>
        <span class="model-badge-tag" style="display:inline-block; font-size:0.68rem; padding:2px 6px;">${escapeHtml(m.tag || 'IA')}</span>
      </button>
    `;
  });

  const cardHtml = `
    <div class="interactive-card" id="${cardId}">
      <div class="interactive-card-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2L13.7 8.3L20 7L15.8 12L20 17L13.7 15.7L12 22L10.3 15.7L4 17L8.2 12L4 7L10.3 8.3L12 2Z"/></svg>
        <span>Modelos de Claude Disponibles</span>
      </div>
      <div class="interactive-card-sub">Selecciona el modelo que deseas activar para las próximas respuestas del agente:</div>
      <div class="interactive-grid">
        ${buttonsHtml}
      </div>
      <div class="interactive-actions">
        <button type="button" class="interactive-action-btn card-btn-add">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>Añadir modelo personalizado...</span>
        </button>
        <button type="button" class="interactive-action-btn card-btn-sync">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
          <span>Sincronizar con Anthropic</span>
        </button>
      </div>
    </div>
  `;

  const row = renderAssistantCard(cardHtml);
  const cardElem = row.querySelector(`#${cardId}`);
  if (cardElem) {
    cardElem.querySelectorAll('.interactive-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-model-id');
        const name = btn.getAttribute('data-name');
        const tag = btn.getAttribute('data-tag');
        setModel(id, name, tag);
        cardElem.querySelectorAll('.interactive-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showToast(`Modelo cambiado a ${name}`);
      });
    });

    const addBtn = cardElem.querySelector('.card-btn-add');
    if (addBtn) addBtn.addEventListener('click', openCustomModelModal);

    const syncBtn = cardElem.querySelector('.card-btn-sync');
    if (syncBtn) syncBtn.addEventListener('click', handleSyncModels);
  }
}

function handleSlashMode(arg) {
  const modeKeys = Object.keys(EXECUTION_MODES);
  if (arg) {
    const lower = arg.toLowerCase().replace(/[-_]/g, '');
    let matchedKey = null;
    if (lower.includes('auto')) matchedKey = 'auto';
    else if (lower.includes('accept') || lower.includes('edit')) matchedKey = 'acceptEdits';
    else if (lower.includes('plan')) matchedKey = 'plan';
    else if (lower.includes('manual')) matchedKey = 'manual';

    if (matchedKey) {
      const info = EXECUTION_MODES[matchedKey];
      setPermissionMode(matchedKey, info.icon, info.label);
      renderAssistantCard(`
        <div class="interactive-card">
          <div class="interactive-card-title">
            <span class="mode-icon-current">${info.icon}</span>
            <span>Modo de ejecución cambiado a: ${escapeHtml(info.label)}</span>
          </div>
        </div>
      `);
      return;
    }
  }

  // Interactive card
  const cardId = 'mode-card-' + Date.now();
  const currentMode = permissionMode ? permissionMode.value : (localStorage.getItem('zer0code_mode') || 'auto');
  let buttonsHtml = '';
  const modeDescriptions = {
    'acceptEdits': 'Recomendado: Zer0 edita y crea archivos automáticamente.',
    'auto': 'Autónomo total: Zer0 ejecuta herramientas y comandos sin confirmación.',
    'plan': 'Solo planificación: Zer0 analiza y diseña soluciones sin modificar código.',
    'manual': 'Control manual: Zer0 solicita confirmación antes de cada herramienta.'
  };

  modeKeys.forEach(k => {
    const info = EXECUTION_MODES[k];
    const isAct = currentMode === k;
    buttonsHtml += `
      <button type="button" class="interactive-btn ${isAct ? 'active' : ''}" data-mode-key="${k}">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="display:inline-flex; width:16px; height:16px; color:var(--claude-terracotta);">${info.icon}</span>
          <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
            <span style="font-weight:600;">${escapeHtml(info.label)}</span>
            <span style="font-size:0.72rem; color:var(--text-subtle);">${escapeHtml(modeDescriptions[k] || '')}</span>
          </div>
        </div>
      </button>
    `;
  });

  const cardHtml = `
    <div class="interactive-card" id="${cardId}">
      <div class="interactive-card-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
        <span>Modo de Ejecución de Claude Code</span>
      </div>
      <div class="interactive-card-sub">Selecciona el nivel de autonomía y permisos del agente:</div>
      <div class="interactive-grid" style="grid-template-columns: 1fr;">
        ${buttonsHtml}
      </div>
    </div>
  `;

  const row = renderAssistantCard(cardHtml);
  const cardElem = row.querySelector(`#${cardId}`);
  if (cardElem) {
    cardElem.querySelectorAll('.interactive-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-mode-key');
        const info = EXECUTION_MODES[k];
        setPermissionMode(k, info.icon, info.label);
        cardElem.querySelectorAll('.interactive-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showToast(`Modo cambiado a ${info.label}`);
      });
    });
  }
}

function handleSlashStatus() {
  const currentInfo = getModelInfo(selectedModel);
  const curMode = permissionMode ? permissionMode.value : (localStorage.getItem('zer0code_mode') || 'auto');
  const modeInfo = EXECUTION_MODES[curMode] || { label: curMode };

  const keyStatusText = clientApiKey
    ? 'Clave personal configurada'
    : (appMode === 'Hoster' ? 'Cuenta compartida del anfitrión' : 'Clave requerida (no configurada)');

  renderAssistantCard(`
    <div class="interactive-card">
      <div class="interactive-card-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        <span>Estado del Sistema Zer0Code</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; margin-top:10px; font-size:0.82rem;">
        <div style="background:var(--bg-input); padding:10px; border-radius:8px; border:1px solid var(--border-subtle);">
          <div style="color:var(--text-subtle); font-size:0.72rem; text-transform:uppercase;">Carpeta de trabajo</div>
          <div style="font-weight:600; margin-top:3px; word-break:break-all;">${escapeHtml(currentWorkspace || 'No definida')}</div>
        </div>
        <div style="background:var(--bg-input); padding:10px; border-radius:8px; border:1px solid var(--border-subtle);">
          <div style="color:var(--text-subtle); font-size:0.72rem; text-transform:uppercase;">Modelo Activo</div>
          <div style="font-weight:600; margin-top:3px; color:var(--claude-terracotta);">${escapeHtml(currentInfo.name)} <span class="model-badge-tag">${escapeHtml(currentInfo.tag || 'IA')}</span></div>
        </div>
        <div style="background:var(--bg-input); padding:10px; border-radius:8px; border:1px solid var(--border-subtle);">
          <div style="color:var(--text-subtle); font-size:0.72rem; text-transform:uppercase;">Modo de Permisos</div>
          <div style="font-weight:600; margin-top:3px;">${escapeHtml(modeInfo.label)}</div>
        </div>
        <div style="background:var(--bg-input); padding:10px; border-radius:8px; border:1px solid var(--border-subtle);">
          <div style="color:var(--text-subtle); font-size:0.72rem; text-transform:uppercase;">Modo Servidor & Clave</div>
          <div style="font-weight:600; margin-top:3px;">Modo ${escapeHtml(appMode)} &bull; ${escapeHtml(keyStatusText)}</div>
        </div>
      </div>
    </div>
  `);
}

function handleSlashHelp() {
  let commandsListHtml = '';
  SLASH_COMMANDS.forEach(c => {
    commandsListHtml += `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; padding:8px 0; border-bottom:1px solid var(--border-subtle); gap:12px;">
        <div>
          <div style="display:flex; align-items:center; gap:6px;">
            <code style="color:var(--claude-terracotta); font-weight:600; font-size:0.86rem;">${escapeHtml(c.name)}</code>
            ${c.hint ? `<span style="font-size:0.75rem; color:var(--text-subtle);">${escapeHtml(c.hint)}</span>` : ''}
          </div>
          <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">${escapeHtml(c.desc)}</div>
        </div>
        <span class="slash-cmd-badge" style="font-size:0.7rem; padding:3px 8px;">${escapeHtml(c.badge)}</span>
      </div>
    `;
  });

  renderAssistantCard(`
    <div class="interactive-card">
      <div class="interactive-card-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        <span>Comandos Slash Disponibles</span>
      </div>
      <div class="interactive-card-sub">Escribe <code>/</code> en el campo de texto para autocompletar rápidamente cualquiera de estos comandos:</div>
      <div style="margin-top:8px;">
        ${commandsListHtml}
      </div>
    </div>
  `);
}

function handleSlashFolder(arg) {
  if (arg) {
    saveSelectedWorkspaceDirect(arg);
  } else {
    openWorkspaceModal();
  }
}

async function saveSelectedWorkspaceDirect(path) {
  try {
    const res = await authFetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const data = await res.json();
    if (data.success) {
      updateWorkspaceUI(data.workspace);
      renderAssistantCard(`
        <div class="interactive-card">
          <div class="interactive-card-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>Carpeta activa actualizada</span>
          </div>
          <div style="font-size:0.86rem; margin-top:4px;">
            Nueva carpeta de trabajo: <code>${escapeHtml(data.workspace)}</code>
          </div>
        </div>
      `);
    } else {
      renderAssistantCard(`<div style="color:var(--danger-red);">Error cambiando carpeta: ${escapeHtml(data.error || 'Ruta inválida')}</div>`);
    }
  } catch (err) {
    renderAssistantCard(`<div style="color:var(--danger-red);">Error cambiando carpeta: ${escapeHtml(err.message)}</div>`);
  }
}

async function handleSlashSync() {
  const row = renderAssistantCard(`
    <div style="display:flex; align-items:center; gap:8px; color:var(--text-muted);">
      <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
      <span>Consultando catálogo de modelos con Anthropic...</span>
    </div>
  `);

  try {
    const res = await authFetch('/api/models/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await loadModels();
      row.querySelector('.text-body').innerHTML = `
        <div class="interactive-card">
          <div class="interactive-card-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>Modelos sincronizados con éxito</span>
          </div>
          <div style="font-size:0.84rem; margin-top:4px;">
            Modelos actuales: ${data.models.map(m => escapeHtml(m.name)).join(', ')}.${data.removedCount ? ` Se han eliminado ${data.removedCount} modelos antiguos.` : ''} Disponibles con <code>/model</code> o en el selector superior.
          </div>
        </div>
      `;
    } else {
      row.querySelector('.text-body').innerHTML = `<div style="color:var(--danger-red);">${escapeHtml(data.message || 'Error en sincronización')}</div>`;
    }
  } catch (err) {
    row.querySelector('.text-body').innerHTML = `<div style="color:var(--danger-red);">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function sendPrompt(customPrompt, { skipPlanCheck = false } = {}) {
  const typed = (customPrompt || promptInput.value).trim();
  // Al reenviar tras el aviso del plan los adjuntos siguen pendientes
  const hasAttachments = (!customPrompt || skipPlanCheck) && pendingAttachments.length > 0;
  if ((!typed && !hasAttachments) || isRunning) return;
  hidePlanAlert();

  hideSlashPopup();

  // Interceptar Slash Commands
  if (typed.startsWith('/')) {
    const prompt = typed;
    const parts = prompt.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    const cmd = SLASH_COMMANDS.find(c => c.name.toLowerCase() === cmdName);
    if (cmd) {
      promptInput.value = '';
      adjustTextareaHeight();
      appendUserMsg(prompt);
      cmd.action(arg);
      return;
    } else {
      promptInput.value = '';
      adjustTextareaHeight();
      appendUserMsg(prompt);
      renderAssistantCard(`
        <div style="color:var(--text-muted); font-size:0.86rem;">
          Comando desconocido <code>${escapeHtml(cmdName)}</code>. Escribe <code>/help</code> para ver los comandos disponibles.
        </div>
      `);
      return;
    }
  }

  // En Modo Cliente, verificar si hay clave configurada
  if (appMode === 'Client' && (!clientApiKey || !clientApiKey.trim())) {
    openKeyModal();
    if (keyValidationStatus) {
      keyValidationStatus.style.display = 'flex';
      keyValidationStatus.className = 'key-status-box error';
      keyValidationStatus.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> <span>Modo Cliente activo: Ingresa tu propia API Key de Claude antes de enviar mensajes.</span>`;
    }
    return;
  }

  const attachments = hasAttachments ? pendingAttachments : [];
  const prompt = typed || 'Revisa los archivos adjuntos.';

  // Poco margen en el plan y un modelo caro seleccionado: preguntar antes de enviar
  const planWarning = skipPlanCheck ? null : planWarningFor(selectedModel);
  if (planWarning) {
    showPlanAlert(prompt, planWarning);
    return;
  }

  promptInput.value = '';
  adjustTextareaHeight();
  pendingAttachments = [];
  renderAttachPreview();

  appendUserMsg(typed, attachments);
  startStreamingAssistant();
  setRunning(true);

  let encoded = [];
  try {
    encoded = await Promise.all(attachments.map(async att => ({
      name: att.name,
      data: await readFileAsBase64(att.file)
    })));
  } catch (err) {
    showToast('No se pudieron leer los archivos adjuntos');
    setRunning(false);
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'run_task',
      prompt,
      attachments: encoded,
      workspace: currentWorkspace,
      sessionId: activeSessionId,
      permissionMode: permissionMode ? permissionMode.value : 'auto',
      model: selectedModel,
      apiKey: clientApiKey || null,
      effort: effectiveEffort(),
      outputStyle: selectedOutputStyle !== 'default' ? selectedOutputStyle : null,
      customInstructions: readPref('zer0code_custom_instructions', '') || null,
      incognito: incognitoMode
    }));
  }
}

// Marcar como terminadas las herramientas que no recibieron resultado (fin de tarea, error o cancelación)
function finishToolCards(status = 'done') {
  for (const card of currentToolCards.values()) {
    if (card.classList.contains('is-running')) setToolCardStatus(card, status);
  }
  currentToolCards.clear();
}

const TASK_STREAM_EVENTS = new Set(['stream_delta', 'stream_raw', 'stream_thinking', 'tool_use', 'tool_result']);

function handleWsMessage(data) {
  if (TASK_STREAM_EVENTS.has(data.type)) {
    if (resyncBuffer) {
      resyncBuffer.push(data);
      return;
    }
    // Eventos de otra conversación (la tarea sigue en segundo plano) o ya pintados
    if (data.sessionId && activeSessionId && data.sessionId !== activeSessionId) return;
    if (data.seq) {
      if (data.seq <= lastTaskSeq) return;
      lastTaskSeq = data.seq;
    }
  }

  switch (data.type) {
    case 'auth_success':
      if (data.user) applyCurrentUser(data.user);
      if (data.workspace) updateWorkspaceUI(data.workspace);
      // La tarea siguió en el servidor mientras no había conexión: recuperar lo generado
      if (data.liveTask) {
        if (!activeSessionId || activeSessionId === data.liveTask.sessionId) {
          openSession(data.liveTask.sessionId);
        } else {
          setRunning(true);
        }
      } else if (isRunning) {
        // Terminó mientras estábamos desconectados: mostrar el resultado guardado
        setRunning(false);
        finishToolCards();
        currentAssistantElement = null;
        if (activeSessionId) openSession(activeSessionId);
        else loadSessions();
      }
      // Al reconectar, recuperar las peticiones de permiso que siguen esperando
      pendingPermissions.clear();
      (data.pendingPermissions || []).forEach(req => pendingPermissions.set(req.id, req));
      renderPermissionDock();
      break;

    case 'user_updated':
      if (data.user) applyCurrentUser(data.user);
      break;

    // Otro dispositivo de la misma cuenta ha enviado un mensaje en la conversación que tengo abierta
    case 'user_message':
      if (data.sessionId && data.sessionId === activeSessionId && !isRunning && data.message) {
        appendUserMsg(data.message.text, (data.message.attachments || []).map(name => ({ name })));
        startStreamingAssistant();
        setRunning(true);
      }
      break;

    // Otro dispositivo creó, borró o actualizó una conversación: refrescar la lista
    case 'sessions_changed':
      scheduleSessionsRefresh();
      break;

    case 'permission_request':
      if (data.request) {
        pendingPermissions.set(data.request.id, data.request);
        renderPermissionDock();
      }
      break;

    case 'permission_resolved':
      settlePermissionCard(data.id, data.allowed);
      break;

    case 'assistant_start':
      lastTaskSeq = 0;
      if (data.sessionId && !activeSessionId) {
        activeSessionId = data.sessionId;
        if (incognitoMode) incognitoSessionId = data.sessionId;
      }
      break;

    case 'stream_delta':
    case 'stream_raw':
      if (currentTextElement) {
        currentAccumulatedText += data.text;
        currentSegmentText += data.text;
        // Evitar párrafos vacíos al inicio de un bloque nuevo tras una herramienta
        if (!currentSegmentText.trim()) break;
        currentTextElement.style.display = '';
        if (window.marked) {
          currentTextElement.innerHTML = renderMarkdown(currentSegmentText);
        } else {
          currentTextElement.textContent = currentSegmentText;
        }
        scrollToBottom();
      }
      break;

    case 'stream_thinking':
      if (currentThinkingElement) {
        currentAccumulatedThinking += data.thinking;
        currentThinkingElement.style.display = 'block';
        currentThinkingElement.querySelector('.thinking-content').textContent = currentAccumulatedThinking;
        scrollToBottom();
      }
      break;

    case 'tool_use':
      if (currentAssistantElement && currentTextElement && !data.subagent) {
        const bubble = currentAssistantElement.querySelector('.msg-bubble');
        const toolCard = buildToolCard({ tool: data.tool, input: data.input, status: 'running' });
        if (data.id) currentToolCards.set(data.id, toolCard);

        // Si el bloque de texto actual está vacío (o es el placeholder), la tarjeta ocupa su lugar
        if (!currentSegmentText.trim()) {
          bubble.insertBefore(toolCard, currentTextElement);
          currentTextElement.innerHTML = '';
          currentTextElement.style.display = 'none';
        } else {
          // Cerrar el bloque de texto y abrir uno nuevo debajo de la herramienta
          bubble.appendChild(toolCard);
          const nextText = document.createElement('div');
          nextText.className = 'text-body';
          nextText.style.display = 'none';
          bubble.appendChild(nextText);
          currentTextElement = nextText;
          currentSegmentText = '';
        }
        scrollToBottom();
      }
      break;

    case 'tool_result': {
      const card = currentToolCards.get(data.id);
      if (card) {
        setToolCardStatus(card, data.isError ? 'error' : 'done');
        if (data.isError && data.content) {
          card.insertAdjacentHTML('beforeend', `<pre class="claude-tool-body tool-error">${escapeHtml(data.content.slice(0, 600))}</pre>`);
          card.open = true;
        }
      }
      break;
    }

    case 'plan_limits':
      if (!clientApiKey && data.limits) {
        planLimitsData = data.limits;
        onPlanLimitsUpdated();
      }
      break;

    case 'task_completed':
      finishToolCards();
      if (currentTextElement && data.message && data.message.text && !currentAccumulatedText.trim()) {
        currentAccumulatedText = data.message.text;
        currentTextElement.style.display = '';
        if (window.marked) {
          currentTextElement.innerHTML = renderMarkdown(currentAccumulatedText);
        } else {
          currentTextElement.textContent = currentAccumulatedText;
        }
      }
      if (currentAssistantElement && data.message) appendCostFooter(currentAssistantElement, data.message.cost);
      setRunning(false);
      currentAssistantElement = null;
      loadSessions();
      loadProviderUsage();
      break;

    case 'task_error':
      finishToolCards('error');
      if (currentTextElement) {
        currentTextElement.style.display = '';
        currentTextElement.innerHTML += `<div style="color:var(--danger-red); margin-top:8px; display:flex; align-items:center; gap:6px;">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          <span>Error: ${escapeHtml(data.message.error || 'Error en ejecución')}</span>
        </div>`;
      }
      setRunning(false);
      currentAssistantElement = null;
      loadSessions();
      break;

    case 'task_canceled':
      finishToolCards('error');
      if (currentTextElement) {
        currentTextElement.style.display = '';
        currentTextElement.innerHTML += `<div style="color:var(--text-subtle); margin-top:8px; display:flex; align-items:center; gap:6px;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>Tarea cancelada</span>
        </div>`;
      }
      setRunning(false);
      currentAssistantElement = null;
      break;

    case 'workspace_changed':
      updateWorkspaceUI(data.workspace);
      break;

    case 'session_moved':
      showToast(`${data.created ? 'Proyecto creado' : 'Conversación movida'}: ${data.name || data.workspace}`);
      break;

    case 'models_updated':
      applyModelsList(data.models, data.defaultModel);
      break;
  }
}

function setRunning(running) {
  isRunning = running;
  mainApp.classList.toggle('is-running', running);
  if (running) {
    if (statusIndicator) statusIndicator.className = 'status-indicator busy';
    if (statusText) statusText.textContent = 'Zer0 trabajando';
    if (btnModelTrigger) btnModelTrigger.classList.add('working');
    btnSend.style.display = 'none';
    btnStop.style.display = 'flex';
  } else {
    if (statusIndicator) statusIndicator.className = 'status-indicator';
    if (statusText) statusText.textContent = 'Conectado';
    if (btnModelTrigger) btnModelTrigger.classList.remove('working');
    btnSend.style.display = 'flex';
    btnStop.style.display = 'none';
  }
}

function cancelActiveTask() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel_task' }));
  }
}

// Auto-grow textarea
function adjustTextareaHeight() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 240) + 'px';
  const inputCard = promptInput.closest('.input-card');
  if (inputCard) inputCard.classList.toggle('has-text', promptInput.value.trim().length > 0);
}

// ==========================================================================
// 6. Dictado por Voz (Web Speech API)
// ==========================================================================
function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  // El WebView de la app de Android expone la API pero no dicta: mejor no ofrecer el botón
  if (!SpeechRecognition || inAndroidApp()) {
    btnVoice.style.display = 'none';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = true;

  // Lo dictado se añade a lo que ya hubiera escrito, sin borrarlo
  let baseText = '';

  recognition.onstart = () => {
    isListening = true;
    btnVoice.classList.add('listening');
  };

  recognition.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; ++i) {
      transcript += e.results[i][0].transcript;
    }
    promptInput.value = (baseText ? baseText + ' ' : '') + transcript.trim();
    adjustTextareaHeight();
  };

  recognition.onerror = (e) => {
    const reasons = {
      'not-allowed': 'Permiso de micrófono denegado: actívalo en el candado de la barra de direcciones',
      'service-not-allowed': 'Este navegador no permite el dictado (prueba con Chrome o Edge)',
      'audio-capture': 'No se ha encontrado ningún micrófono',
      network: 'El dictado no funciona en este navegador (Brave y Opera lo bloquean): prueba con Chrome o Edge',
      'language-not-supported': 'El dictado en español no está disponible en este navegador',
    };
    if (reasons[e.error]) showToast(reasons[e.error]);
    stopVoice();
  };
  recognition.onend = () => stopVoice();

  btnVoice.addEventListener('click', async () => {
    if (isListening) {
      recognition.stop();
      return;
    }
    // Pedir el micrófono antes: así el navegador muestra el aviso de permiso y los fallos se ven
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch (err) {
        showToast(err.name === 'NotFoundError' ? 'No se ha encontrado ningún micrófono' : 'Permiso de micrófono denegado: actívalo en el candado de la barra de direcciones');
        return;
      }
    }
    baseText = promptInput.value.trim();
    try {
      recognition.start();
    } catch (err) {
      showToast('No se pudo iniciar el dictado');
    }
  });
}

function stopVoice() {
  isListening = false;
  btnVoice.classList.remove('listening');
}

// ==========================================================================
// 7. Modal de Selección de Carpeta (Workspace)
// ==========================================================================
async function openWorkspaceModal() {
  workspaceModal.style.display = 'flex';
  browsingDirectory = currentWorkspace;
  customDirInput.value = currentWorkspace;
  await loadQuickLocations();
  await loadDirectory(browsingDirectory);
}

function closeWorkspaceModal() {
  workspaceModal.style.display = 'none';
}

async function loadQuickLocations() {
  try {
    const res = await authFetch('/api/quick-locations');
    const data = await res.json();
    quickLocationsList.innerHTML = '';
    if (data.locations) {
      data.locations.forEach(loc => {
        const btn = document.createElement('button');
        btn.className = 'loc-chip';
        btn.textContent = loc.name;
        btn.addEventListener('click', () => loadDirectory(loc.path));
        quickLocationsList.appendChild(btn);
      });
    }
  } catch (e) {}
}

async function loadDirectory(targetPath) {
  foldersList.innerHTML = '<div class="dir-loading">Cargando...</div>';
  try {
    const res = await authFetch(`/api/workspace?dir=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    if (data.success) {
      browsingDirectory = data.current;
      customDirInput.value = data.current;
      foldersList.innerHTML = '';

      if (data.folders.length === 0) {
        foldersList.innerHTML = '<div style="padding:8px; color:var(--text-subtle); font-size:0.8rem;">Sin subcarpetas</div>';
      }

      data.folders.forEach(f => {
        const row = document.createElement('div');
        row.className = 'folder-row';
        row.innerHTML = `<span class="folder-svg-icon" style="display:flex;align-items:center;color:var(--claude-terracotta);"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span> <span>${escapeHtml(f.name)}</span>`;
        row.addEventListener('click', () => loadDirectory(f.path));
        foldersList.appendChild(row);
      });

      btnDirUp.disabled = !data.parent;
      btnDirUp.onclick = () => {
        if (data.parent) loadDirectory(data.parent);
      };
    } else {
      foldersList.innerHTML = `<div style="padding:8px; color:var(--danger-red); font-size:0.8rem;">${escapeHtml(data.error)}</div>`;
    }
  } catch (err) {
    foldersList.innerHTML = '<div style="padding:8px; color:var(--danger-red); font-size:0.8rem;">Error al leer carpeta</div>';
  }
}

async function saveSelectedWorkspace() {
  const selected = customDirInput.value.trim() || browsingDirectory;
  try {
    const res = await authFetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected })
    });
    const data = await res.json();
    if (data.success) {
      updateWorkspaceUI(data.workspace);
      closeWorkspaceModal();
    }
  } catch (err) {
    alert('Error cambiando carpeta: ' + err.message);
  }
}

async function createNewFolder() {
  const name = newFolderName.value.trim();
  if (!name) return;
  try {
    const res = await authFetch('/api/workspace/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: browsingDirectory, name })
    });
    const data = await res.json();
    if (data.success) {
      newFolderName.value = '';
      loadDirectory(browsingDirectory);
    }
  } catch (e) {}
}

// ==========================================================================
// 8. Key Configuration Modal (Hoster / Client)
// ==========================================================================
const SVG_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const SVG_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

function openKeyModal() {
  if (!keyModal) return;
  keyModal.style.display = 'flex';

  if (clientApiKeyInput) {
    clientApiKeyInput.value = clientApiKey;
    clientApiKeyInput.type = 'password';
  }
  if (btnToggleKeyVis) {
    btnToggleKeyVis.innerHTML = SVG_EYE;
  }
  if (keyValidationStatus) {
    keyValidationStatus.style.display = 'none';
    keyValidationStatus.className = 'key-status-box';
    keyValidationStatus.textContent = '';
  }
  if (btnDeleteKey) {
    btnDeleteKey.style.display = clientApiKey ? 'inline-flex' : 'none';
  }

  if (keyModalModeBadge && keyModalModeStatus && keyModalModeDesc) {
    if (appMode === 'Client') {
      keyModalModeBadge.textContent = 'Modo Cliente';
      keyModalModeBadge.className = 'mode-badge-pill client';
      keyModalModeStatus.textContent = clientApiKey ? 'Clave configurada en este dispositivo' : 'Clave requerida para operar';
      keyModalModeDesc.textContent = 'El anfitrión ha configurado este servidor en Modo Cliente. Tu clave se almacena únicamente en tu navegador/móvil y no se comparte con otros usuarios ni con el anfitrión.';
    } else {
      const isHostLoggedIn = serverAuthInfo && serverAuthInfo.loggedIn;
      keyModalModeBadge.textContent = 'Modo Hoster';
      keyModalModeBadge.className = isHostLoggedIn ? 'mode-badge-pill hoster' : 'mode-badge-pill client';
      if (isHostLoggedIn) {
        const plan = serverAuthInfo.subscriptionType ? serverAuthInfo.subscriptionType.toUpperCase() : 'PRO';
        keyModalModeStatus.textContent = `Cuenta activa (${serverAuthInfo.email || 'Conectada'} - Plan ${plan})`;
        keyModalModeDesc.textContent = `El servidor está en Modo Hoster: el anfitrión comparte su suscripción o cuenta (${serverAuthInfo.email || 'Claude'}). Puedes enviar prompts sin necesidad de ingresar ninguna clave. Si deseas usar tu propia clave para no consumir la cuota del anfitrión, puedes ingresarla aquí.`;
      } else {
        keyModalModeStatus.textContent = '⚠️ Cuenta del anfitrión no vinculada';
        keyModalModeDesc.textContent = 'El anfitrión aún no ha iniciado sesión en Claude Code. Para vincularla: 1) En la consola del servidor ejecuta "pnpm auth:login", o 2) Añade ANTHROPIC_API_KEY en el archivo .env. También puedes ingresar una clave personal aquí abajo.';
      }
    }
  }
}

function closeKeyModal() {
  if (keyModal) keyModal.style.display = 'none';
}

function toggleKeyVisibility() {
  if (!clientApiKeyInput || !btnToggleKeyVis) return;
  if (clientApiKeyInput.type === 'password') {
    clientApiKeyInput.type = 'text';
    btnToggleKeyVis.innerHTML = SVG_EYE_OFF;
  } else {
    clientApiKeyInput.type = 'password';
    btnToggleKeyVis.innerHTML = SVG_EYE;
  }
}

async function handleValidateKey() {
  const inputKey = clientApiKeyInput.value.trim();
  if (!inputKey) {
    keyValidationStatus.style.display = 'flex';
    keyValidationStatus.className = 'key-status-box error';
    keyValidationStatus.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> <span>Por favor escribe una clave antes de comprobar.</span>`;
    return;
  }

  keyValidationStatus.style.display = 'flex';
  keyValidationStatus.className = 'key-status-box checking';
  keyValidationStatus.innerHTML = `<svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> <span>Comprobando clave con Anthropic...</span>`;

  try {
    const res = await authFetch('/api/auth/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: inputKey })
    });
    const result = await res.json();
    if (result.valid) {
      keyValidationStatus.className = 'key-status-box success';
      keyValidationStatus.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Clave válida y confirmada por Anthropic.</span>`;
    } else {
      keyValidationStatus.className = 'key-status-box error';
      keyValidationStatus.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg> <span>${escapeHtml(result.message || 'Clave no reconocida por Anthropic')}</span>`;
    }
  } catch (err) {
    keyValidationStatus.className = 'key-status-box error';
    keyValidationStatus.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg> <span>Error al comunicarse con el servidor.</span>`;
  }
}

function handleSaveKey() {
  const inputKey = clientApiKeyInput.value.trim();
  if (!inputKey && appMode === 'Client') {
    keyValidationStatus.style.display = 'flex';
    keyValidationStatus.className = 'key-status-box error';
    keyValidationStatus.textContent = 'En Modo Cliente es obligatorio ingresar una clave de Claude.';
    return;
  }

  clientApiKey = inputKey;
  if (clientApiKey) {
    localStorage.setItem('zer0code_client_key', clientApiKey);
  } else {
    localStorage.removeItem('zer0code_client_key');
  }

  updateModeUI();
  closeKeyModal();
}

function handleDeleteKey() {
  clientApiKey = '';
  localStorage.removeItem('zer0code_client_key');
  if (clientApiKeyInput) clientApiKeyInput.value = '';
  if (btnDeleteKey) btnDeleteKey.style.display = 'none';
  if (keyValidationStatus) {
    keyValidationStatus.style.display = 'flex';
    keyValidationStatus.className = 'key-status-box error';
    keyValidationStatus.textContent = 'Clave eliminada de este navegador.';
  }
  updateModeUI();
}

// ==========================================================================
// 9. Mobile Sidebar Controls & Event Listeners
// ==========================================================================
function openMobileSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('active');
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('active');
}

// ==========================================================================
// 9. Slash Commands Popover UI & Autocomplete
// ==========================================================================
function renderSlashPopup(matches) {
  currentSlashMatches = matches;
  if (!matches || matches.length === 0) {
    hideSlashPopup();
    return;
  }

  slashPopupList.innerHTML = '';
  matches.forEach((cmd, idx) => {
    const item = document.createElement('div');
    item.className = 'slash-item' + (idx === highlightedSlashIndex ? ' selected' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', idx === highlightedSlashIndex ? 'true' : 'false');
    item.setAttribute('data-index', idx);

    item.innerHTML = `
      <div class="slash-item-left">
        <span class="slash-cmd-name">${escapeHtml(cmd.name)}</span>
        ${cmd.hint ? `<span class="slash-cmd-hint" style="color:var(--text-subtle);font-size:0.75rem;margin-left:4px;">${escapeHtml(cmd.hint)}</span>` : ''}
        <span class="slash-cmd-desc" style="margin-left:8px;color:var(--text-muted);font-size:0.8rem;">${escapeHtml(cmd.desc)}</span>
      </div>
      <span class="slash-cmd-badge">${escapeHtml(cmd.badge)}</span>
    `;

    item.addEventListener('mouseenter', () => {
      highlightedSlashIndex = idx;
      updateSlashHighlight();
    });

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      executeSlashCommand(cmd);
    });

    slashPopupList.appendChild(item);
  });

  slashPopup.style.display = 'block';
}

function updateSlashHighlight() {
  const items = slashPopupList.querySelectorAll('.slash-item');
  items.forEach((it, idx) => {
    const isSel = idx === highlightedSlashIndex;
    it.classList.toggle('selected', isSel);
    it.setAttribute('aria-selected', isSel ? 'true' : 'false');
    if (isSel) {
      it.scrollIntoView({ block: 'nearest' });
    }
  });
}

function hideSlashPopup() {
  if (slashPopup) slashPopup.style.display = 'none';
  highlightedSlashIndex = -1;
  currentSlashMatches = [];
}

function executeSlashCommand(cmd, customArg) {
  hideSlashPopup();
  promptInput.value = '';
  adjustTextareaHeight();
  appendUserMsg(cmd.name + (customArg ? ' ' + customArg : ''));
  cmd.action(customArg || '');
}

function handlePromptInputSlash() {
  const val = promptInput.value;
  if (!val.startsWith('/')) {
    hideSlashPopup();
    return;
  }

  if (val.includes(' ')) {
    hideSlashPopup();
    return;
  }

  const query = val.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter(cmd => {
    const nameWithoutSlash = cmd.name.slice(1).toLowerCase();
    return nameWithoutSlash.startsWith(query) || cmd.desc.toLowerCase().includes(query) || cmd.badge.toLowerCase().includes(query);
  });

  if (matches.length > 0) {
    highlightedSlashIndex = 0;
    renderSlashPopup(matches);
  } else {
    hideSlashPopup();
  }
}

// ==========================================================================
// 10. Gestión Dinámica de Modelos
// ==========================================================================
function renderModelDropdown() {
  if (!dynamicModelList) return;
  dynamicModelList.innerHTML = '';

  const claudeModels = availableModelsList.filter(m => !m.provider);
  const mainModels = claudeModels.filter(m => !m.legacy);
  const legacyModels = claudeModels.filter(m => m.legacy);

  // Claude, ChatGPT y Gemini, cada uno en su submenú
  const groups = [['claude', 'Claude', mainModels]].concat(
    Object.entries(PROVIDER_LABELS).map(([provider, label]) => [provider, label, availableModelsList.filter(m => m.provider === provider)])
  );
  groups.forEach(([provider, label, models]) => {
    if (!models.length) return;
    const connected = providersStatus[provider]?.loggedIn;
    const active = models.some(m => m.id === selectedModel);
    const group = document.createElement('div');
    group.className = `submenu provider-models${active ? ' has-selected' : ''}`;
    group.dataset.provider = provider;
    group.innerHTML = `
      <button type="button" class="dropdown-item submenu-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="submenu-label">${escapeHtml(label)}${connected === false ? ' <span class="provider-off">sin conectar</span>' : ''}</span>
        <svg class="submenu-chevron"><use href="#i-chevron-right"/></svg>
      </button>
      <div class="submenu-flyout" role="listbox"></div>
    `;
    const flyout = group.querySelector('.submenu-flyout');
    if (provider === 'gemini') {
      const switcher = buildGeminiBackendSwitch();
      if (switcher) flyout.appendChild(switcher);
    }
    models.forEach(m => flyout.appendChild(buildModelOption(m)));
    bindSubmenu(group);
    dynamicModelList.appendChild(group);
  });

  // Submenú "Más modelos" con las generaciones anteriores
  const moreSlot = document.getElementById('more-models-slot');
  if (moreSlot) {
    moreSlot.innerHTML = '';
    if (legacyModels.length > 0) {
      const more = document.createElement('div');
      more.className = 'submenu more-models';
      more.innerHTML = `
        <button type="button" class="dropdown-item submenu-trigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="submenu-label">Más modelos</span>
          <svg class="submenu-chevron"><use href="#i-chevron-right"/></svg>
        </button>
        <div class="submenu-flyout" role="listbox"></div>
      `;
      const flyout = more.querySelector('.submenu-flyout');
      legacyModels.forEach(m => flyout.appendChild(buildModelOption(m, { compact: true })));
      bindSubmenu(more);
      moreSlot.appendChild(more);
    }
  }

  updateModelTrigger();
  refreshModelSelectionMarks();
  if (shellReady) renderEffortOptions();
}

// Elegir con qué CLI se usa Gemini (solo si el servidor tiene los dos)
const GEMINI_BACKEND_LABELS = { antigravity: 'Antigravity', gemini: 'Gemini CLI' };

function buildGeminiBackendSwitch() {
  const status = providersStatus.gemini;
  if (!status || !Array.isArray(status.backends) || status.backends.length < 2) return null;
  const wrap = document.createElement('div');
  wrap.className = 'gemini-backend-switch';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Usar Gemini con');
  status.backends.forEach(backend => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `gemini-backend-option${status.backend === backend ? ' active' : ''}`;
    btn.textContent = GEMINI_BACKEND_LABELS[backend] || backend;
    btn.setAttribute('aria-pressed', status.backend === backend ? 'true' : 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (status.backend !== backend) setGeminiBackend(backend);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

async function setGeminiBackend(backend) {
  try {
    const res = await authFetch('/api/providers/gemini-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'No se pudo cambiar');
    providersStatus = data.providers;
    applyModelsList(data.models, data.defaultModel);
    showToast(`Gemini ahora usa ${GEMINI_BACKEND_LABELS[backend] || backend}`);
    // Mantener abierto el submenú de Gemini tras redibujar
    const gemini = dynamicModelList.querySelector('.provider-models[data-provider="gemini"]');
    if (gemini) {
      gemini.classList.add('open');
      placeSubmenuFlyout(gemini);
    }
  } catch (err) {
    showToast(`Gemini: ${err.message}`);
  }
}

function buildModelOption(m, { compact = false } = {}) {
  const isSelected = selectedModel === m.id;
  const isUserModel = m.custom && m.source !== 'anthropic';
  const item = document.createElement('div');
  item.className = `dropdown-item model-option${compact ? ' model-option-compact' : ''}${isSelected ? ' selected' : ''}`;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  item.setAttribute('data-model', m.id);

  const deleteBtn = isUserModel
    ? `<button type="button" class="btn-del-model" data-id="${escapeHtml(m.id)}" title="Eliminar modelo" aria-label="Eliminar modelo"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`
    : '';

  const multiplier = costMultiplier(m);
  const subscription = isSubscriptionBilling();
  const priceLine = subscription || m.provider
    ? ''
    : (m.pricing ? `${formatPrice(m.pricing.input)} entrada · ${formatPrice(m.pricing.output)} salida / MTok` : 'Precio no disponible');
  const chipTitle = subscription
    ? `Consumo relativo según la tarifa del modelo: cuanto más alto, antes gastas el límite de uso de ${planLabel()}`
    : 'Gasto relativo al modelo más barato';
  item.title = m.pricing && !subscription
    ?`${m.name}\nEntrada: ${formatPrice(m.pricing.input)} / MTok\nSalida: ${formatPrice(m.pricing.output)} / MTok${m.pricing.cacheRead != null ? `\nCaché (lectura): ${formatPrice(m.pricing.cacheRead)} / MTok` : ''}`
    : m.name;

  item.innerHTML = `
    <div class="item-content">
      <div class="item-title-row">
        <span class="item-title">${escapeHtml(shortModelName(m.name))}</span>
        ${multiplier ? `<span class="cost-chip" title="${escapeHtml(chipTitle)}">${multiplier}</span>` : ''}
      </div>
      ${compact ? '' : `<div class="item-desc">${escapeHtml(m.desc || m.id)}</div>${priceLine ? `<div class="item-price">${escapeHtml(priceLine)}</div>` : ''}`}
    </div>
    ${deleteBtn}
    <svg class="item-check"><use href="#i-check"/></svg>
  `;

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const delBtn = e.target.closest('.btn-del-model');
    if (delBtn) {
      deleteCustomModel(delBtn.getAttribute('data-id'));
      return;
    }
    setModel(m.id, m.name, m.tag);
    closeAllDropdowns();
  });

  return item;
}

function shortModelName(name) {
  return String(name || '').replace(/^Claude\s+/i, '');
}

// Niveles de esfuerzo que admite un modelo, según las capacidades que publica la API
function effortLevelsFor(modelId) {
  const info = availableModelsList.find(m => m.id === modelId);
  if (info && Array.isArray(info.effortLevels)) return info.effortLevels;
  // Modelos añadidos a mano (sin datos de la API): Haiku no admite esfuerzo
  return /haiku/i.test(String(modelId || '')) ? [] : ['low', 'medium', 'high', 'xhigh', 'max'];
}

function modelSupportsEffort(modelId) {
  return effortLevelsFor(modelId).length > 0;
}

// Esfuerzo que se enviará realmente con el modelo actual (null = el predeterminado del modelo)
function effectiveEffort() {
  if (selectedEffort === 'auto') return null;
  return effortLevelsFor(selectedModel).includes(selectedEffort) ? selectedEffort : null;
}

// ¿Se está usando una suscripción (Pro/Max) en lugar de una clave de API?
// Con suscripción no se cobra por tokens: los importes en dólares serían solo una referencia.
function isSubscriptionBilling() {
  if (clientApiKey) return false;
  return !!(serverAuthInfo && serverAuthInfo.loggedIn && serverAuthInfo.authMethod === 'claude.ai');
}

function planLabel() {
  const plan = serverAuthInfo && serverAuthInfo.subscriptionType;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase() : 'tu plan';
}

// Multiplicador de gasto respecto al modelo más barato (por precio de salida)
function costMultiplier(model) {
  if (!model || !model.pricing) return null;
  const outputs = availableModelsList.map(m => m.pricing && m.pricing.output).filter(v => v > 0);
  if (outputs.length === 0) return null;
  const ratio = model.pricing.output / Math.min(...outputs);
  return Number.isInteger(ratio) ? `×${ratio}` : `×${ratio.toFixed(1).replace(/\.0$/, '')}`;
}

function formatPrice(value) {
  return `$${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')}`;
}

function formatUsd(value) {
  if (!value) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// Coste de una respuesta, debajo del mensaje
function appendCostFooter(row, cost) {
  if (!row || !cost || row.querySelector('.msg-cost')) return;
  const entries = Object.entries(cost.byModel || {});
  const tokens = entries.reduce((s, [, u]) => s + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0);
  const detail = entries
    .map(([id, u]) => `${shortModelName(getModelInfo(id).name || id)}: ${formatUsd(u.costUSD)} (${formatTokens(u.outputTokens)} de salida)`)
    .join('\n');
  const footer = document.createElement('div');
  footer.className = 'msg-cost';
  if (isSubscriptionBilling()) {
    footer.title = `Usa tu suscripción ${planLabel()}: no se cobra por tokens.\n${detail}\n(Importe solo orientativo: lo que costaría en la API)`;
    footer.textContent = `${formatTokens(tokens)} tokens`;
  } else {
    footer.title = `${detail}\nCalculado por Claude Code a precio de tarifa de la API`;
    footer.textContent = `${formatUsd(cost.totalCostUSD)} · ${formatTokens(tokens)} tokens`;
  }
  row.appendChild(footer);
}

function updateModelTrigger() {
  const info = getModelInfo(selectedModel);
  if (currentModelName) currentModelName.textContent = shortModelName(info.name || selectedModel);
  if (currentModelTag) {
    currentModelTag.textContent = modelSupportsEffort(selectedModel) ? effortLabel(effectiveEffort() || 'auto') : '';
  }
  const effortSubmenu = document.getElementById('effort-submenu');
  if (effortSubmenu) effortSubmenu.hidden = !modelSupportsEffort(selectedModel);
}

function refreshModelSelectionMarks() {
  document.querySelectorAll('.model-option').forEach(opt => {
    const isMatch = opt.getAttribute('data-model') === selectedModel;
    opt.classList.toggle('selected', isMatch);
    opt.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
  const more = document.querySelector('.more-models');
  if (more) more.classList.toggle('has-selected', !!more.querySelector('.model-option.selected'));
}

function setModel(modelId) {
  selectedModel = modelId;
  writePref('zer0code_model', modelId);
  updateModelTrigger();
  refreshModelSelectionMarks();
  renderEffortOptions();
}

function openCustomModelModal() {
  closeAllDropdowns();
  if (!customModelModal) return;
  customModelModal.style.display = 'flex';
  if (customModelIdInput) customModelIdInput.value = '';
  if (customModelNameInput) customModelNameInput.value = '';
  if (customModelTagInput) customModelTagInput.value = '';
  if (customModelDescInput) customModelDescInput.value = '';
  if (customModelStatus) {
    customModelStatus.style.display = 'none';
    customModelStatus.className = 'key-status-box';
    customModelStatus.textContent = '';
  }
}

function closeCustomModelModal() {
  if (customModelModal) customModelModal.style.display = 'none';
}

async function handleSaveCustomModel() {
  const id = customModelIdInput.value.trim();
  const name = customModelNameInput.value.trim() || id;
  const tag = customModelTagInput.value.trim() || 'Custom';
  const desc = customModelDescInput.value.trim() || 'Modelo personalizado';

  if (!id) {
    customModelStatus.style.display = 'flex';
    customModelStatus.className = 'key-status-box error';
    customModelStatus.textContent = 'El ID del modelo es obligatorio (ej. claude-opus-5-5).';
    return;
  }

  try {
    customModelStatus.style.display = 'flex';
    customModelStatus.className = 'key-status-box checking';
    customModelStatus.textContent = 'Guardando modelo...';

    const res = await authFetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, tag, desc })
    });
    const data = await res.json();
    if (data.success) {
      customModelStatus.className = 'key-status-box success';
      customModelStatus.textContent = 'Modelo guardado correctamente.';
      setModel(id, name, tag);
      await loadModels();
      showToast(`Modelo ${name} añadido`);
      setTimeout(closeCustomModelModal, 400);
    } else {
      customModelStatus.className = 'key-status-box error';
      customModelStatus.textContent = data.error || data.message || 'Error guardando modelo.';
    }
  } catch (err) {
    customModelStatus.className = 'key-status-box error';
    customModelStatus.textContent = 'Error de conexión: ' + err.message;
  }
}

async function deleteCustomModel(id) {
  if (!confirm(`¿Deseas eliminar el modelo ${id}?`)) return;
  try {
    const res = await authFetch(`/api/models/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      if (selectedModel === id) {
        selectedModel = DEFAULT_MODEL_ID;
        localStorage.setItem('zer0code_model', selectedModel);
      }
      await loadModels();
      showToast('Modelo eliminado');
    }
  } catch (err) {
    alert('Error eliminando modelo: ' + err.message);
  }
}

async function handleSyncModels() {
  const btn = btnSyncModels;
  if (btn) {
    btn.disabled = true;
    const span = btn.querySelector('span');
    if (span) span.textContent = 'Sincronizando...';
  }
  try {
    const res = await authFetch('/api/models/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      applyModelsList(data.models, data.defaultModel);
      const removedTxt = data.removedCount ? `, ${data.removedCount} antiguos eliminados` : '';
      showToast(`Modelos sincronizados (${data.models.length} disponibles${removedTxt})`);
    } else {
      showToast(data.message || 'Error sincronizando modelos');
    }
  } catch (err) {
    showToast('Error sincronizando con Anthropic: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      const span = btn.querySelector('span');
      if (span) span.textContent = 'Sincronizar con Anthropic';
    }
    closeAllDropdowns();
  }
}

// ==========================================================================
// 11. Listeners y Dropdown Handlers
// ==========================================================================
function setupEventListeners() {
  btnSend.addEventListener('click', () => sendPrompt());
  btnStop.addEventListener('click', cancelActiveTask);
  setupAttachments();

  promptInput.addEventListener('keydown', (e) => {
    if (slashPopup && slashPopup.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentSlashMatches.length > 0) {
          highlightedSlashIndex = (highlightedSlashIndex + 1) % currentSlashMatches.length;
          updateSlashHighlight();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentSlashMatches.length > 0) {
          highlightedSlashIndex = (highlightedSlashIndex - 1 + currentSlashMatches.length) % currentSlashMatches.length;
          updateSlashHighlight();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (highlightedSlashIndex >= 0 && highlightedSlashIndex < currentSlashMatches.length) {
          const cmd = currentSlashMatches[highlightedSlashIndex];
          promptInput.value = cmd.name + (cmd.hint ? ' ' : '');
          hideSlashPopup();
          adjustTextareaHeight();
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (highlightedSlashIndex >= 0 && highlightedSlashIndex < currentSlashMatches.length) {
          const cmd = currentSlashMatches[highlightedSlashIndex];
          executeSlashCommand(cmd);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlashPopup();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  promptInput.addEventListener('input', () => {
    adjustTextareaHeight();
    handlePromptInputSlash();
  });

  // New Chat
  btnNewChat.addEventListener('click', newChat);

  // Suggested Prompts
  document.querySelectorAll('.starter-card').forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.getAttribute('data-prompt');
      if (prompt) sendPrompt(prompt);
    });
  });

  // Mobile sidebar
  btnHamburger.addEventListener('click', () => {
    if (mobileQuery.matches) openMobileSidebar();
    else setSidebarCollapsed(false);
  });
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);

  // Workspace modal
  btnOpenWorkspace.addEventListener('click', openWorkspaceModal);
  btnChangeWs.addEventListener('click', openWorkspaceModal);
  btnCloseModal.addEventListener('click', closeWorkspaceModal);
  btnCancelWorkspace.addEventListener('click', closeWorkspaceModal);
  btnSelectWorkspace.addEventListener('click', saveSelectedWorkspace);

  btnDirGo.addEventListener('click', () => {
    const target = customDirInput.value.trim();
    if (target) loadDirectory(target);
  });
  btnCreateFolder.addEventListener('click', createNewFolder);

  // Modo & Key modal listeners
  if (btnModeIndicator) btnModeIndicator.addEventListener('click', openKeyModal);
  if (btnSidebarKey) btnSidebarKey.addEventListener('click', openKeyModal);
  if (btnCloseKeyModal) btnCloseKeyModal.addEventListener('click', closeKeyModal);
  if (btnCancelKeyModal) btnCancelKeyModal.addEventListener('click', closeKeyModal);
  if (btnSaveKeyModal) btnSaveKeyModal.addEventListener('click', handleSaveKey);
  if (btnDeleteKey) btnDeleteKey.addEventListener('click', handleDeleteKey);
  if (btnTestKey) btnTestKey.addEventListener('click', handleValidateKey);
  if (btnToggleKeyVis) btnToggleKeyVis.addEventListener('click', toggleKeyVisibility);

  // Custom Model Modal listeners
  if (btnOpenAddModel) btnOpenAddModel.addEventListener('click', openCustomModelModal);
  if (btnSyncModels) btnSyncModels.addEventListener('click', handleSyncModels);
  if (btnCloseCustomModelModal) btnCloseCustomModelModal.addEventListener('click', closeCustomModelModal);
  if (btnCancelCustomModelModal) btnCancelCustomModelModal.addEventListener('click', closeCustomModelModal);
  if (btnSaveCustomModel) btnSaveCustomModel.addEventListener('click', handleSaveCustomModel);

  // Custom Dropdowns (Model & Execution Mode)
  setupDropdowns();
}

function initModelAndMode() {
  const rawModel = sanitizeStoredModel(localStorage.getItem('zer0code_model'));
  const modelInfo = getModelInfo(rawModel);
  setModel(modelInfo.id, modelInfo.name, modelInfo.tag);
  renderModelDropdown();

  let savedMode = localStorage.getItem('zer0code_mode') || 'auto';
  if (savedMode === 'acceptEdits') {
    savedMode = 'auto';
    localStorage.setItem('zer0code_mode', savedMode);
  }
  const modeInfo = EXECUTION_MODES[savedMode] || EXECUTION_MODES['auto'];
  setPermissionMode(savedMode, modeInfo.icon, modeInfo.label);
  applyAllowedModes();
}

// Mostrar solo los modos que el admin ha concedido a este usuario
function applyAllowedModes() {
  const allowed = currentUser?.allowedModes;
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  document.querySelectorAll('.mode-option').forEach(opt => {
    opt.hidden = !allowed.includes(opt.getAttribute('data-value'));
  });
  const current = permissionMode ? permissionMode.value : null;
  if (!allowed.includes(current)) {
    const fallback = allowed[0];
    setPermissionMode(fallback, null, EXECUTION_MODES[fallback]?.label);
  }
}

function setPermissionMode(modeValue, modeIcon, modeLabel) {
  localStorage.setItem('zer0code_mode', modeValue);
  if (permissionMode) permissionMode.value = modeValue;
  const info = EXECUTION_MODES[modeValue] || { icon: modeIcon || '', label: modeLabel || modeValue };
  if (currentModeIcon) currentModeIcon.innerHTML = info.icon;
  if (currentModeLabel) currentModeLabel.textContent = info.label;

  document.querySelectorAll('.mode-option').forEach(opt => {
    const isMatch = opt.getAttribute('data-value') === modeValue;
    opt.classList.toggle('selected', isMatch);
    opt.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
}

function closeAllDropdowns() {
  document.querySelectorAll('.custom-dropdown.open').forEach(dd => {
    dd.classList.remove('open');
    dd.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll('.submenu.open').forEach(el => el.classList.remove('open'));
}

function setupDropdowns() {
  if (btnModelTrigger) {
    btnModelTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !dropdownModel.classList.contains('open');
      closeAllDropdowns();
      if (willOpen) {
        dropdownModel.classList.add('open');
        btnModelTrigger.setAttribute('aria-expanded', 'true');
        placeDropdownMenu(dropdownModel);
      }
    });
  }

  if (btnModeTrigger) {
    btnModeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !dropdownMode.classList.contains('open');
      closeAllDropdowns();
      if (willOpen) {
        dropdownMode.classList.add('open');
        btnModeTrigger.setAttribute('aria-expanded', 'true');
        placeDropdownMenu(dropdownMode);
      }
    });
  }

  document.querySelectorAll('.mode-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = opt.getAttribute('data-value');
      const label = opt.getAttribute('data-label');
      setPermissionMode(val, null, label);
      closeAllDropdowns();
    });
  });

  document.addEventListener('click', (e) => {
    closeAllDropdowns();
    if (!e.target.closest('#slash-popup') && !e.target.closest('#prompt-input')) {
      hideSlashPopup();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
      hideSlashPopup();
    }
  });
}

// ==========================================================================
// 10. Interfaz: inicio/conversación, incógnito, personalización y menús
// ==========================================================================
const EFFORT_OPTIONS = [
  { value: 'auto', label: 'Auto', desc: 'El modelo decide cuánto pensar' },
  { value: 'low', label: 'Bajo', desc: 'Más rápido, para tareas sencillas' },
  { value: 'medium', label: 'Medio', desc: 'Equilibrio entre rapidez y profundidad' },
  { value: 'high', label: 'Alto', desc: 'Razona más a fondo' },
  { value: 'xhigh', label: 'Muy alto', desc: 'Para problemas complejos' },
  { value: 'max', label: 'Máximo', desc: 'Todo el razonamiento posible' }
];

const OUTPUT_STYLE_LABELS = {
  default: 'Estilo',
  Explanatory: 'Explicativo',
  Learning: 'Aprendizaje'
};

const mobileQuery = window.matchMedia('(max-width: 768px)');
const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let shellReady = false;

function effortLabel(value) {
  return (EFFORT_OPTIONS.find(o => o.value === value) || EFFORT_OPTIONS[0]).label;
}

function shortPathName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

// --- Inicio vs. conversación ------------------------------------------------
function syncEmptyState() {
  const empty = emptyState.style.display !== 'none';
  mainApp.classList.toggle('main-app-empty', empty);
  mainApp.classList.toggle('is-chat', !empty);
  promptInput.placeholder = empty ? '¿En qué puedo ayudarte hoy?' : 'Responde a Zer0…';
  updateTopTitle();
}

function updateTopTitle() {
  if (!topChatTitle) return;
  if (incognitoMode) {
    topChatTitle.innerHTML = '<span class="incognito-chip"><svg><use href="#i-ghost"/></svg>Chat incógnito</span>';
    return;
  }
  const empty = emptyState.style.display !== 'none';
  const session = lastSessionsList.find(s => s.id === activeSessionId);
  topChatTitle.textContent = empty ? '' : (session ? session.title : '');
}

let defaultStarters = null;

/** Sustituye los atajos de la pantalla de inicio por los del perfil, si los tiene. */
function applyStarters() {
  const box = document.querySelector('.starter-cards');
  if (!box) return;
  if (!defaultStarters) defaultStarters = [...box.children];
  const starters = currentUser?.profile?.starters;
  if (!starters?.length) {
    box.replaceChildren(...defaultStarters);
    return;
  }
  const cards = starters.map(item => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'starter-card';
    card.dataset.prompt = item.prompt;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${/^[a-z-]+$/.test(item.icon || '') ? item.icon : 'feather'}`);
    icon.appendChild(use);
    const text = document.createElement('span');
    text.className = 'starter-text';
    text.textContent = item.label;
    card.append(icon, text);
    card.addEventListener('click', () => sendPrompt(item.prompt));
    return card;
  });
  box.replaceChildren(...cards);
}

function updateGreeting() {
  applyStarters();
  const greeting = document.getElementById('greeting-text');
  if (!greeting) return;
  const name = identityProfile?.displayName || readPref('zer0code_display_name', '').trim();
  if (incognitoMode) {
    greeting.textContent = 'Chat incógnito';
  } else {
    greeting.textContent = currentUser?.profile?.greeting || defaultGreeting(name || currentUsername);
  }
}

/** Saludo según el día y la hora, con el nombre si lo hay. */
function defaultGreeting(name) {
  const now = new Date();
  const hour = now.getHours();
  const day = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][now.getDay()];
  const base = hour >= 5 && hour < 12 ? `Feliz ${day}` : hour >= 12 && hour < 20 ? 'Buenas tardes' : 'Buenas noches';
  return name ? `${base}, ${name}` : base;
}

function updateUserIdentity() {
  const name = identityProfile?.displayName || readPref('zer0code_display_name', '').trim() || currentUsername || 'Usuario';
  if (userDisplayName) userDisplayName.textContent = name;
  if (userAvatarLetter) {
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0)).join('');
    const avatarUrl = identityProfile?.avatarUrl || '';
    const avatarKey = `${currentUsername}:${avatarUrl}`;
    if (userAvatarLetter.dataset.avatarKey !== avatarKey) {
      userAvatarLetter.dataset.avatarKey = avatarKey;
      userAvatarLetter.textContent = (initials || 'U').toUpperCase();
      if (avatarUrl) {
        const avatar = new Image();
        avatar.alt = '';
        avatar.referrerPolicy = 'no-referrer';
        avatar.onload = () => { if (userAvatarLetter.dataset.avatarKey === avatarKey) userAvatarLetter.replaceChildren(avatar); };
        avatar.src = avatarUrl;
      }
    } else if (!userAvatarLetter.querySelector('img')) {
      userAvatarLetter.textContent = (initials || 'U').toUpperCase();
    }
  }
  const email = document.getElementById('user-menu-email');
  if (email) email.textContent = identityProfile?.email || '';
}

async function loadGlobalProfile() {
  const username = currentUsername;
  try {
    const response = await authFetch('/api/profile');
    const data = await response.json();
    if (data.success && currentUsername === username && authToken) {
      identityProfile = data.profile;
      updateUserIdentity();
      updateGreeting();
    }
  } catch {}
}

async function loadProviderUsage(force = false) {
  const username = currentUsername;
  try {
    const response = await authFetch(`/api/usage/providers${force ? '?refresh=1' : ''}`, {
      headers: clientApiKey ? { 'x-claude-api-key': 'present' } : {}
    });
    const data = await response.json();
    if (!data.success || currentUsername !== username || !authToken) return;
    providerUsageData = data;
    renderProviderUsage();
  } catch {
    const summary = document.getElementById('provider-usage-summary');
    if (summary) summary.textContent = 'No se pudo consultar el uso por IA.';
  }
}

function renderProviderUsage() {
  const providers = providerUsageData?.providers || [];
  const chips = document.getElementById('provider-usage-chips');
  chips?.querySelectorAll('[data-provider-usage]').forEach(button => button.remove());
  for (const provider of providers.filter(provider => provider.id !== 'claude')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-btn';
    button.dataset.providerUsage = provider.id;
    const icon = `<svg class="chip-icon"><use href="#i-${PROVIDER_ICONS[provider.id] || 'spark'}"/></svg>`;
    const win = provider.quota.available ? tightestWindow(provider.quota) : null;
    if (win) {
      button.className = `chip-btn plan-chip ${win.percent >= PLAN_CRITICAL_PERCENT ? 'is-full' : win.percent >= PLAN_WARN_PERCENT ? 'is-warn' : ''}`;
      button.innerHTML = `${icon}${escapeHtml(provider.name)} ${Math.round(win.percent)}%`;
      button.title = `${win.key === 'session' ? 'Sesión' : 'Semana'}: ${formatPlanReset(win.resetsAt)}`;
    } else {
      const usage = provider.localUsage;
      const detail = provider.connection.loggedIn ? usage.tracked ? `${usage.responses} resp.` : 'sin datos' : 'sin conectar';
      button.innerHTML = `${icon}${escapeHtml(provider.name)} · ${escapeHtml(detail)}`;
    }
    if (!win) button.title = provider.quota.message || "";
    chips?.append(button);
  }
  const summary = document.getElementById('provider-usage-summary');
  if (!summary) return;
  summary.innerHTML = providers.map(provider => {
    const usage = provider.localUsage;
    const quota = provider.quota;
    const windows = [['Sesión', quota.session], ['Semana', quota.weekly]].filter(([, value]) => value);
    const limits = quota.available ? windows.map(([label, value]) => `<div>${label}: <strong>${Math.round(value.percent)}% usado</strong> · ${escapeHtml(formatPlanReset(value.resetsAt))}</div>`).join('') : escapeHtml(quota.message);
    const tokens = usage.tokensAvailable ? `${formatTokens(usage.totalTokens)} tokens` : 'tokens no disponibles';
    return `<article class="provider-usage-card"><h4>${escapeHtml(provider.name)} <small>${escapeHtml(provider.cli)}</small></h4><p>${limits}</p>${quota.scopeLabel ? `<p>${escapeHtml(quota.scopeLabel)}</p>` : ''}<p>Tu uso en Zer0Code: ${usage.responses} ejecuciones (incluye revisiones) · ${tokens}</p>${usage.note ? `<p>${escapeHtml(usage.note)}</p>` : ''}</article>`;
  }).join('');
}

// --- Incógnito --------------------------------------------------------------
function discardIncognitoSession({ keepalive = false } = {}) {
  if (!incognitoSessionId) return;
  const id = incognitoSessionId;
  incognitoSessionId = null;
  if (activeSessionId === id) activeSessionId = null;
  fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    keepalive,
    headers: { 'Authorization': `Bearer ${authToken}` }
  }).catch(() => {});
}

function setIncognito(on) {
  if (on === incognitoMode) return;
  if (!on) discardIncognitoSession();
  incognitoMode = on;
  mainApp.classList.toggle('incognito', on);
  const btn = document.getElementById('btn-incognito');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Salir del chat incógnito' : 'Chat incógnito';
  }
  const plusLabel = document.getElementById('plus-incognito-label');
  if (plusLabel) plusLabel.textContent = on ? 'Salir del chat incógnito' : 'Chat incógnito';
  newChat();
  updateGreeting();
  updateTopTitle();
  if (on) showToast('Chat incógnito: no se guardará en Recientes');
}

// --- Tema, acento y fuente --------------------------------------------------
function resolveTheme(choice) {
  if (choice === 'system') return darkSchemeQuery.matches ? 'dark' : 'light';
  return choice === 'dark' ? 'dark' : 'light';
}

function applyTheme(choice, { persist = true } = {}) {
  if (persist) writePref('zer0code_theme', choice);
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0b0d' : '#fafafa');
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === choice));
  document.querySelectorAll('#pz-theme button').forEach(b => b.classList.toggle('active', b.dataset.value === choice));
}

function applyAccent(value, { persist = true } = {}) {
  // Acentos antiguos que ya no existen: vuelven al de Zer0
  if (!value || value === 'terracotta' || value === 'ocean') value = 'zero';
  if (persist) writePref('zer0code_accent', value);
  document.documentElement.dataset.accent = value;
  document.querySelectorAll('#pz-accent button').forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

function applyChatFont(value, { persist = true } = {}) {
  if (persist) writePref('zer0code_chat_font', value);
  document.documentElement.dataset.chatFont = value;
  document.querySelectorAll('#pz-font button').forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

// --- Modal Personalizar -----------------------------------------------------
let personalizeSnapshot = null;

function openPersonalizeModal() {
  closeAllDropdowns();
  closeMobileSidebar();
  personalizeSnapshot = {
    theme: readPref('zer0code_theme', 'light'),
    accent: readPref('zer0code_accent', 'zero'),
    font: readPref('zer0code_chat_font', 'sans')
  };
  document.getElementById('pz-name').value = identityProfile?.displayName || readPref('zer0code_display_name', '');
  document.getElementById('pz-instructions').value = readPref('zer0code_custom_instructions', '');
  applyTheme(personalizeSnapshot.theme, { persist: false });
  applyAccent(personalizeSnapshot.accent, { persist: false });
  applyChatFont(personalizeSnapshot.font, { persist: false });
  document.getElementById('personalize-modal').style.display = 'flex';
  document.getElementById('pz-name').focus();
}

function closePersonalizeModal({ revert = true } = {}) {
  const modal = document.getElementById('personalize-modal');
  if (!modal || modal.style.display === 'none') return;
  if (revert && personalizeSnapshot) {
    applyTheme(personalizeSnapshot.theme, { persist: false });
    applyAccent(personalizeSnapshot.accent, { persist: false });
    applyChatFont(personalizeSnapshot.font, { persist: false });
  }
  personalizeSnapshot = null;
  modal.style.display = 'none';
}

async function savePersonalization() {
  const pick = (groupId, fallback) => {
    const active = document.querySelector(`#${groupId} button.active`);
    return active ? active.dataset.value : fallback;
  };
  const saveButton = document.getElementById('btn-save-personalize');
  const username = currentUsername;
  saveButton.disabled = true;
  try {
    const response = await authFetch('/api/profile', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: document.getElementById('pz-name').value.trim() })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'No se pudo guardar el nombre visible.');
    if (currentUsername !== username || !authToken) return;
    identityProfile = result.profile;
    writePref('zer0code_display_name', '');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar el nombre visible.');
    return;
  } finally {
    saveButton.disabled = false;
  }
  writePref('zer0code_custom_instructions', document.getElementById('pz-instructions').value.trim());
  applyTheme(pick('pz-theme', 'light'));
  applyAccent(pick('pz-accent', 'zero'));
  applyChatFont(pick('pz-font', 'sans'));
  closePersonalizeModal({ revert: false });
  updateGreeting();
  updateUserIdentity();
  showToast('Preferencias guardadas');
}

// --- Submenús y desplegables ------------------------------------------------
function bindSubmenu(submenu) {
  const trigger = submenu.querySelector('.submenu-trigger');
  const setOpen = (open) => {
    submenu.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) placeSubmenuFlyout(submenu);
    // Integrado, el submenú hace crecer el menú: recolocarlo para que siga cabiendo en pantalla
    const dropdown = submenu.closest('.custom-dropdown');
    if (dropdown && submenu.closest('.submenus-inline')) placeDropdownMenu(dropdown);
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !submenu.classList.contains('open');
    submenu.parentElement.closest('.dropdown-menu')?.querySelectorAll('.submenu.open').forEach(s => s !== submenu && s.classList.remove('open'));
    setOpen(willOpen);
  });
  // En escritorio se abren al pasar el ratón, como en claude.ai. Al salir se espera un momento
  // antes de cerrar, para que dé tiempo a llevar el ratón hasta el submenú.
  const canHover = window.matchMedia('(hover: hover) and (min-width: 769px)');
  let closeTimer = null;
  // Con los submenús integrados (menú con scroll o sin sitio al lado) se abren con clic
  const hoverable = () => canHover.matches && !submenu.closest('.submenus-inline');
  submenu.addEventListener('mouseenter', () => {
    if (!hoverable()) return;
    clearTimeout(closeTimer);
    setOpen(true);
  });
  submenu.addEventListener('mouseleave', () => {
    if (!hoverable()) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => setOpen(false), 300);
  });
}

function bindDropdown(dropdownId, triggerId, onOpen) {
  const dropdown = document.getElementById(dropdownId);
  const trigger = document.getElementById(triggerId);
  if (!dropdown || !trigger) return;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !dropdown.classList.contains('open');
    closeAllDropdowns();
    if (willOpen) {
      if (onOpen) onOpen();
      dropdown.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      placeDropdownMenu(dropdown);
    }
  });
}

// Abrir el menú hacia arriba o hacia abajo según el espacio disponible en pantalla
function placeDropdownMenu(dropdown) {
  const menu = dropdown.querySelector(':scope > .dropdown-menu');
  if (!menu) return;
  menu.classList.remove('flip-up', 'flip-down', 'menu-scroll', 'submenus-inline');
  menu.style.maxHeight = '';
  menu.style.left = '';
  menu.style.right = '';
  // Que no se salga por los lados (en móvil el botón no está pegado al borde)
  let rect = menu.getBoundingClientRect();
  const css = getComputedStyle(menu);
  if (rect.left < 8 && css.right !== 'auto') {
    menu.style.right = `${parseFloat(css.right) - (8 - rect.left)}px`;
  } else if (rect.right > window.innerWidth - 8 && css.left !== 'auto') {
    menu.style.left = `${parseFloat(css.left) - (rect.right - window.innerWidth + 8)}px`;
  }
  // Los submenús se abren a la izquierda; si ahí no caben (los taparía la barra lateral), van integrados.
  // Se decide antes de medir el alto porque integrados hacen crecer el menú.
  const bounds = (dropdown.closest('.main-content') || document.body).getBoundingClientRect();
  if (menu.querySelector('.submenu') && menu.getBoundingClientRect().left - bounds.left < 280) {
    menu.classList.add('submenus-inline');
  }
  const anchor = dropdown.getBoundingClientRect();
  const needed = menu.scrollHeight + 12;
  const spaceBelow = window.innerHeight - anchor.bottom;
  const spaceAbove = anchor.top;
  rect = menu.getBoundingClientRect();
  let opensDown = rect.top >= anchor.top;
  if (opensDown && spaceBelow < needed && spaceAbove > spaceBelow) {
    menu.classList.add('flip-up');
    opensDown = false;
  } else if (!opensDown && spaceAbove < needed && spaceBelow > spaceAbove) {
    menu.classList.add('flip-down');
    opensDown = true;
  }
  // Si tampoco cabe en el lado elegido, se recorta a la pantalla y pasa a tener scroll
  const available = (opensDown ? spaceBelow : spaceAbove) - 16;
  if (needed > available) {
    menu.style.maxHeight = `${Math.max(available, 160)}px`;
    menu.classList.add('menu-scroll', 'submenus-inline');
  }
}

// Submenú lateral: alinearlo por arriba o por abajo para que no se salga de la pantalla
function placeSubmenuFlyout(submenu) {
  const flyout = submenu.querySelector(':scope > .submenu-flyout');
  if (!flyout || mobileQuery.matches || submenu.closest('.submenus-inline')) return;
  flyout.classList.remove('flyout-up');
  flyout.style.top = '';
  flyout.style.bottom = '';
  flyout.style.maxHeight = `${Math.min(440, window.innerHeight - 16)}px`;
  let rect = flyout.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 8) flyout.classList.add('flyout-up');
  // Si al abrirlo hacia arriba se sale por arriba, se baja lo justo para que se vea entero
  rect = flyout.getBoundingClientRect();
  if (rect.top < 8) {
    const css = getComputedStyle(flyout);
    flyout.style.bottom = `${parseFloat(css.bottom) - (8 - rect.top)}px`;
  }
}

// Recolocar el menú abierto si cambia el tamaño de la ventana (girar el móvil, teclado…)
window.addEventListener('resize', () => {
  document.querySelectorAll('.custom-dropdown.open').forEach(placeDropdownMenu);
});

function renderEffortOptions() {
  const list = document.getElementById('effort-options');
  if (!list) return;
  list.innerHTML = '';
  // Solo los niveles que admite el modelo elegido (Auto siempre está)
  const supported = effortLevelsFor(selectedModel);
  const current = effectiveEffort() || 'auto';
  EFFORT_OPTIONS.filter(opt => opt.value === 'auto' || supported.includes(opt.value)).forEach(opt => {
    const item = document.createElement('div');
    item.className = `dropdown-item${opt.value === current ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.innerHTML = `
      <div class="item-content">
        <div class="item-title">${opt.label}</div>
        <div class="item-desc">${opt.desc}</div>
      </div>
      <svg class="item-check"><use href="#i-check"/></svg>
    `;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedEffort = opt.value;
      writePref('zer0code_effort', opt.value);
      renderEffortOptions();
      updateModelTrigger();
      closeAllDropdowns();
    });
    list.appendChild(item);
  });
  const currentLabel = document.getElementById('effort-current-label');
  if (currentLabel) currentLabel.textContent = effortLabel(current);
}

function setOutputStyle(value) {
  selectedOutputStyle = OUTPUT_STYLE_LABELS[value] ? value : 'default';
  writePref('zer0code_output_style', selectedOutputStyle);
  const label = document.getElementById('current-output-label');
  if (label) label.textContent = OUTPUT_STYLE_LABELS[selectedOutputStyle];
  document.querySelectorAll('.output-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === selectedOutputStyle);
  });
}

// --- Proyecto (carpeta de trabajo) -------------------------------------------
function renderProjectMenu() {
  const list = document.getElementById('project-recent-list');
  if (!list) return;
  const seen = new Set();
  const folders = [currentWorkspace, ...lastSessionsList.map(s => s.workspace)]
    .filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .slice(0, 6);

  list.innerHTML = '';
  if (folders.length === 0) {
    list.innerHTML = '<div class="project-recent-empty">Aún no hay carpetas recientes</div>';
    return;
  }
  folders.forEach(folder => {
    const row = document.createElement('div');
    row.className = `dropdown-item project-row${folder === currentWorkspace ? ' selected' : ''}`;
    row.innerHTML = `
      <div class="item-content">
        <div class="item-title">${escapeHtml(shortPathName(folder))}</div>
        <span class="project-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
      </div>
      <svg class="item-check"><use href="#i-check"/></svg>
    `;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      if (folder !== currentWorkspace) switchWorkspaceQuiet(folder);
    });
    list.appendChild(row);
  });
}

async function switchWorkspaceQuiet(folder) {
  try {
    const res = await authFetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder })
    });
    const data = await res.json();
    if (data.success) {
      updateWorkspaceUI(data.workspace);
      showToast(`Proyecto: ${shortPathName(data.workspace)}`);
    } else {
      showToast(data.error || 'No se pudo cambiar de carpeta');
    }
  } catch (err) {
    showToast('No se pudo cambiar de carpeta');
  }
}

// --- Uso y gasto ---------------------------------------------------------------
async function openUsageModal() {
  closeAllDropdowns();
  closeMobileSidebar();
  const modal = document.getElementById('usage-modal');
  const resetBtn = document.getElementById('btn-reset-usage');
  if (resetBtn) {
    resetBtn.textContent = 'Reiniciar contadores locales';
    delete resetBtn.dataset.confirm;
  }
  modal.style.display = 'flex';
  loadPlanLimits();
  loadProviderUsage();
  try {
    const res = await authFetch('/api/usage');
    const data = await res.json();
    renderUsage(data.usage, data.pricing, data.monthlyLimit);
  } catch (err) {
    document.getElementById('usage-body').innerHTML = '<div class="usage-empty">No se pudo cargar el uso</div>';
  }
}

function closeUsageModal() {
  const modal = document.getElementById('usage-modal');
  if (modal) modal.style.display = 'none';
}

function renderUsage(usage, pricing, monthlyLimit = null) {
  const body = document.getElementById('usage-body');
  const rows = Object.entries(usage.models || {}).sort((a, b) => b[1].costUSD - a[1].costUSD);
  const maxCost = rows.length ? rows[0][1].costUSD || 1 : 1;
  const since = new Date(usage.since).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  const pricingDate = pricing && pricing.fetchedAt
    ? new Date(pricing.fetchedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
    : null;

  const tableRows = rows.map(([id, u]) => {
    const info = getModelInfo(id);
    const knownCost = info.provider ? info.provider === 'claude' : !/^(gpt|codex|gemini|o\d)/i.test(id);
    const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const multiplier = costMultiplier(info);
    return `
      <tr>
        <td>
          ${escapeHtml(shortModelName(info.name || id))}
          ${multiplier ? `<span class="cost-chip">${multiplier}</span>` : ''}
          <span class="usage-bar" style="width:${Math.max(4, Math.round((u.costUSD / maxCost) * 100))}%"></span>
        </td>
        <td>${u.responses}</td>
        <td title="Entrada ${formatTokens(u.inputTokens)} · Salida ${formatTokens(u.outputTokens)} · Caché ${formatTokens(u.cacheReadTokens + u.cacheWriteTokens)}">${formatTokens(tokens)}</td>
        <td class="${isSubscriptionBilling() ? 'usage-ref' : ''}">${knownCost ? formatUsd(u.costUSD) : '—'}</td>
      </tr>`;
  }).join('');

  const subscription = isSubscriptionBilling();
  const totalTokens = rows.reduce((s, [, u]) => s + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0);
  const pricingNote = pricingDate ? ` Tarifas oficiales actualizadas el ${escapeHtml(pricingDate)}.` : '';
  const note = subscription
    ? `<strong>Claude usa la suscripción ${escapeHtml(planLabel())}</strong>. La columna «Equiv. API» de Claude es una referencia de tarifa, no un cobro de la suscripción. ChatGPT y Gemini usan sus propias cuentas: «—» significa precio no disponible. Los tokens locales no son el porcentaje de una cuota.${pricingNote}`
    : `Los importes de Claude con clave de API son estimaciones a precio de tarifa. No incluyen los cargos de ChatGPT ni Gemini: «—» significa precio no disponible.${pricingNote}`;

  const limitHtml = monthlyLimit
    ? `<div class="usage-limit${monthlyLimit.reached ? ' is-reached' : ''}">
        <span>Tu límite este mes: <strong>${formatUsd(monthlyLimit.spentUSD)}</strong> de ${formatUsd(monthlyLimit.limitUSD)}</span>
        ${planMeterHtml(Math.min(100, (monthlyLimit.spentUSD / (monthlyLimit.limitUSD || 1)) * 100))}
        ${monthlyLimit.reached ? '<span>Has llegado al límite: pídele al administrador que lo amplíe o usa tu propia clave de API.</span>' : ''}
      </div>`
    : '';

  body.innerHTML = `
    ${limitHtml}
    <div class="usage-summary">
      <span class="usage-total">${subscription ? `${formatTokens(totalTokens)} tokens` : formatUsd(usage.totalCostUSD)}</span>
      <span class="usage-total-label">desde el ${escapeHtml(since)}</span>
    </div>
    <div class="usage-table-wrap">
      ${rows.length ? `
        <table class="usage-table">
          <thead><tr><th>Modelo</th><th title="Incluye desarrollo y rondas de revisión">Ejecuciones</th><th>Tokens</th><th>${subscription ? 'Equiv. API' : 'Coste'}</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : '<div class="usage-empty">Todavía no hay respuestas registradas</div>'}
    </div>
    <p class="usage-note">${note}</p>
  `;
}

// --- Seguridad ---------------------------------------------------------------
function openSecurityModal() {
  closeAllDropdowns();
  closeMobileSidebar();
  const form = document.getElementById('security-password-form');
  form.reset();
  document.getElementById('security-user').value = currentUsername;
  document.getElementById('security-status').style.display = 'none';
  const btn = document.getElementById('btn-logout-all');
  btn.textContent = 'Cerrar sesión en todos los dispositivos';
  delete btn.dataset.confirm;
  document.getElementById('security-modal').style.display = 'flex';
}

function closeSecurityModal() {
  document.getElementById('security-modal').style.display = 'none';
}

function setSecurityStatus(ok, message) {
  const box = document.getElementById('security-status');
  box.className = `key-status-box ${ok ? 'success' : 'error'}`;
  box.textContent = message;
  box.style.display = 'flex';
}

async function handleSecurityPasswordSubmit(e) {
  e.preventDefault();
  const current = document.getElementById('security-current').value;
  const next = document.getElementById('security-new').value;
  if (next !== document.getElementById('security-confirm').value) {
    setSecurityStatus(false, 'Las contraseñas nuevas no coinciden');
    return;
  }
  try {
    const data = await requestPasswordChange(current, next);
    if (data.success) {
      e.target.reset();
      setSecurityStatus(true, 'Contraseña cambiada. Se ha cerrado la sesión en el resto de dispositivos.');
    } else {
      setSecurityStatus(false, data.message || 'No se pudo cambiar la contraseña');
    }
  } catch (err) {
    setSecurityStatus(false, 'Error al conectar con el servidor');
  }
}

async function handleLogoutAll() {
  const btn = document.getElementById('btn-logout-all');
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Seguro? Pulsa otra vez';
    return;
  }
  try {
    await authFetch('/api/auth/logout-all', { method: 'POST' });
  } catch (err) {}
  closeSecurityModal();
  clearAuthToken();
  showLogin();
}

// --- Límites del plan (suscripción) ------------------------------------------
let planLimitsData = null;
let planLimitsLoading = false;

async function loadPlanLimits(force = false) {
  if (planLimitsLoading) return;
  planLimitsLoading = true;
  document.querySelector('#plan-limits .plan-refresh')?.classList.add('is-loading');
  try {
    const res = await authFetch(`/api/usage/plan${force ? '?refresh=1' : ''}`);
    planLimitsData = await res.json();
  } catch (err) {
    planLimitsData = { success: false, message: 'No se pudieron consultar los límites del plan' };
  } finally {
    planLimitsLoading = false;
  }
  onPlanLimitsUpdated();
}

function onPlanLimitsUpdated() {
  renderPlanLimits();
  renderPlanMini();
  renderPlanChip();
  notifyPlanThresholds();
}

const PLAN_WARN_PERCENT = 80;
const PLAN_CRITICAL_PERCENT = 90;
const PLAN_WINDOW_LABELS = { session: 'la sesión actual', weekly: 'el límite semanal' };

// Ventana más apurada (sesión o semana), si hay datos de suscripción
function tightestPlanWindow() {
  const data = planLimitsData;
  if (clientApiKey || !data || !data.success) return null;
  return ['session', 'weekly']
    .filter(key => data[key])
    .map(key => ({ key, ...data[key] }))
    .sort((a, b) => b.percent - a.percent)[0] || null;
}

const PROVIDER_ICONS = { claude: 'claude', codex: 'openai', gemini: 'gemini' };

// Ventana de cuota más apurada (sesión o semana) de un proveedor
function tightestWindow(quota) {
  return ['session', 'weekly']
    .filter(key => quota[key])
    .map(key => ({ key, ...quota[key] }))
    .sort((a, b) => b.percent - a.percent)[0] || null;
}

function renderPlanChip() {
  const chip = document.getElementById('plan-chip');
  if (!chip) return;
  const win = tightestPlanWindow();
  if (!win) {
    chip.hidden = false;
    chip.className = 'chip-btn plan-chip';
    chip.innerHTML = '<svg class="chip-icon"><use href="#i-claude"/></svg>Claude · cuota no disponible';
    return;
  }
  chip.className = `chip-btn plan-chip ${win.percent >= PLAN_CRITICAL_PERCENT ? 'is-full' : win.percent >= PLAN_WARN_PERCENT ? 'is-warn' : ''}`;
  chip.innerHTML = `<svg class="chip-icon"><use href="#i-claude"/></svg>Claude ${Math.round(win.percent)}%`;
  chip.title = `${win.key === 'session' ? 'Sesión' : 'Semana'}: ${formatPlanReset(win.resetsAt)}`;
  chip.hidden = false;
}

// Aviso en pantalla al cruzar el 80 % y el 100 %, una sola vez por ventana de uso
function notifyPlanThresholds() {
  const data = planLimitsData;
  if (clientApiKey || !data || !data.success) return;
  const seen = readJsonPref('zer0code_plan_alerts');
  let changed = false;
  for (const key of ['session', 'weekly']) {
    const win = data[key];
    if (!win) continue;
    const level = win.percent >= 100 ? 100 : win.percent >= PLAN_WARN_PERCENT ? PLAN_WARN_PERCENT : 0;
    const prev = seen[key] && seen[key].resetsAt === win.resetsAt ? seen[key].level : 0;
    if (level > prev) {
      showToast(level >= 100
        ? `Has alcanzado ${PLAN_WINDOW_LABELS[key]}. ${formatPlanReset(win.resetsAt)}`
        : `Llevas el ${Math.round(win.percent)}% de ${PLAN_WINDOW_LABELS[key]}`);
    }
    if (level !== prev || !seen[key] || seen[key].resetsAt !== win.resetsAt) {
      seen[key] = { resetsAt: win.resetsAt, level: Math.max(level, prev) };
      changed = true;
    }
  }
  if (changed) writePref('zer0code_plan_alerts', JSON.stringify(seen));
}

function readJsonPref(key) {
  try {
    return JSON.parse(readPref(key, '{}')) || {};
  } catch {
    return {};
  }
}

// --- Aviso antes de enviar con un modelo caro cuando queda poco margen ---
let pendingPlanPrompt = null;

function sonnetAlternative() {
  return availableModelsList.find(m => m.id.includes('sonnet') && !m.legacy) || null;
}

function planWarningFor(modelId) {
  const win = tightestPlanWindow();
  if (!win || win.percent < PLAN_CRITICAL_PERCENT) return null;
  if (!/opus|fable/i.test(modelId || '')) return null;
  const sonnet = sonnetAlternative();
  if (!sonnet) return null;
  if (readPref('zer0code_plan_alert_dismissed', '') === `${win.key}:${win.resetsAt}`) return null;
  return { win, sonnet };
}

function showPlanAlert(prompt, warning) {
  pendingPlanPrompt = prompt;
  const alertBox = document.getElementById('plan-alert');
  const model = getModelInfo(selectedModel);
  const modelName = shortModelName(model.name || selectedModel);
  const sonnetName = shortModelName(warning.sonnet.name);
  const ratio = model.pricing && warning.sonnet.pricing && warning.sonnet.pricing.output
    ? model.pricing.output / warning.sonnet.pricing.output
    : null;
  const ratioText = ratio && ratio > 1.05
    ? ` ${escapeHtml(modelName)} gasta unas ${ratio.toFixed(1).replace(/\.0$/, '').replace('.', ',')} veces más que ${escapeHtml(sonnetName)}.`
    : '';

  alertBox.innerHTML = `
    <div class="plan-alert-text">
      <strong>Llevas el ${Math.round(warning.win.percent)}% de ${PLAN_WINDOW_LABELS[warning.win.key]}.</strong>${ratioText}
      <span class="plan-alert-reset">${escapeHtml(formatPlanReset(warning.win.resetsAt))}</span>
    </div>
    <div class="plan-alert-actions">
      <button type="button" class="btn-text" data-plan-action="send">Enviar igualmente</button>
      <button type="button" class="btn-primary-terracotta" data-plan-action="switch">Cambiar a ${escapeHtml(sonnetName)}</button>
    </div>`;
  alertBox.dataset.window = `${warning.win.key}:${warning.win.resetsAt}`;
  alertBox.dataset.sonnet = warning.sonnet.id;
  alertBox.hidden = false;
}

function hidePlanAlert() {
  const alertBox = document.getElementById('plan-alert');
  if (alertBox) alertBox.hidden = true;
  pendingPlanPrompt = null;
}

function handlePlanAlertClick(e) {
  const action = e.target.closest('[data-plan-action]')?.dataset.planAction;
  if (!action) return;
  const alertBox = document.getElementById('plan-alert');
  const prompt = pendingPlanPrompt;
  if (action === 'send') {
    // No volver a preguntar hasta el siguiente restablecimiento
    writePref('zer0code_plan_alert_dismissed', alertBox.dataset.window);
  } else {
    setModel(alertBox.dataset.sonnet);
    showToast(`Modelo: ${shortModelName(getModelInfo(alertBox.dataset.sonnet).name || alertBox.dataset.sonnet)}`);
  }
  hidePlanAlert();
  if (prompt) sendPrompt(prompt, { skipPlanCheck: true });
}

function formatPlanReset(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diffMin = Math.round((date - Date.now()) / 60000);
  if (diffMin <= 0) return 'Se restablece en breve';
  if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return `Se restablece en ${h ? `${h} h ` : ''}${m} min`;
  }
  const day = date.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '');
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `Se restablece el ${day}, ${time}`;
}

function planMeterHtml(percent) {
  const level = percent >= 90 ? ' is-full' : percent >= 70 ? ' is-warn' : '';
  return `<span class="plan-meter${level}"><span style="width:${Math.round(percent)}%"></span></span>`;
}

function planRowHtml(label, win) {
  return `
    <div class="plan-row">
      <div class="plan-row-label">${escapeHtml(label)}<span class="plan-row-reset">${escapeHtml(formatPlanReset(win.resetsAt))}</span></div>
      ${planMeterHtml(win.percent)}
      <span class="plan-row-value">${Math.round(win.percent)}% usado</span>
    </div>`;
}

function renderPlanLimits() {
  const box = document.getElementById('plan-limits');
  if (!box) return;
  const data = planLimitsData;
  if (!data || data.notApplicable) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const head = `
    <div class="plan-limits-head">
      <span class="plan-limits-title">Límites del plan de Claude</span>
      <span class="plan-limits-plan">${escapeHtml(planLabel())}</span>
    </div>`;

  if (!data.success) {
    box.innerHTML = `${head}<p class="plan-limits-error">${escapeHtml(data.message || 'No disponible')}</p>${planFootHtml(null)}`;
    return;
  }

  const rows = [];
  if (data.session) rows.push(planRowHtml('Sesión actual', data.session));
  if (data.weekly || data.weeklyByModel.length) {
    rows.push('<div class="plan-limits-sub">Límites semanales</div>');
    if (data.weekly) rows.push(planRowHtml('Todos los modelos', data.weekly));
    data.weeklyByModel.forEach(w => rows.push(planRowHtml(`Solo ${w.name}`, w)));
  }

  const breakdown = (data.breakdown || []).filter(b => b.percent > 0);
  if (breakdown.length) {
    rows.push(`<p class="plan-limits-error">Esta semana: ${breakdown.map(b => `${escapeHtml(b.name)} ${b.percent}%`).join(' · ')}</p>`);
  }

  const extra = data.extraUsage;
  if (extra && typeof extra.used === 'number') {
    const fmt = v => new Intl.NumberFormat('es-ES', { style: 'currency', currency: extra.currency }).format(v);
    rows.push('<div class="plan-limits-sub">Créditos de uso</div>');
    rows.push(`
      <div class="plan-row">
        <div class="plan-row-label">${fmt(extra.used)} gastados<span class="plan-row-reset">${extra.enabled ? 'Activados' : 'Desactivados'}${extra.limit ? ` · límite mensual ${fmt(extra.limit)}` : ''}</span></div>
      </div>`);
  }

  box.innerHTML = head + rows.join('') + planFootHtml(data.fetchedAt);
}

function planFootHtml(fetchedAt) {
  const when = fetchedAt
    ? (Date.now() - fetchedAt < 60000 ? 'ahora mismo' : new Date(fetchedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))
    : '—';
  return `
    <div class="plan-limits-foot">
      <span>Última actualización: ${when}</span>
      <button type="button" class="plan-refresh" title="Actualizar" aria-label="Actualizar"><svg><use href="#i-refresh"/></svg></button>
    </div>`;
}

function renderPlanMini() {
  const mini = document.getElementById('user-plan-limits');
  if (!mini) return;
  const data = planLimitsData;
  if (!data || !data.success || (!data.session && !data.weekly)) {
    mini.hidden = true;
    return;
  }
  const row = (label, win) => `
    <span class="plan-mini-row">
      <span>${label}</span>
      <span class="plan-row-value">${Math.round(win.percent)}%</span>
      ${planMeterHtml(win.percent)}
    </span>`;
  mini.innerHTML = (data.session ? row('Claude · sesión', data.session) : '') + (data.weekly ? row('Claude · semana', data.weekly) : '');
  mini.hidden = false;
}

async function handleResetUsage() {
  const btn = document.getElementById('btn-reset-usage');
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Seguro? Pulsa otra vez';
    return;
  }
  delete btn.dataset.confirm;
  btn.textContent = 'Reiniciar contadores locales';
  try {
    const res = await authFetch('/api/usage/reset', { method: 'POST' });
    const data = await res.json();
    renderUsage(data.usage, null);
    loadProviderUsage();
    showToast('Contador de gasto reiniciado');
  } catch (err) {
    showToast('No se pudo reiniciar el contador');
  }
}

// --- Barra lateral -----------------------------------------------------------
function setSidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
  writePref('zer0code_sidebar_collapsed', collapsed ? '1' : '0');
}

function focusSidebarSearch() {
  if (mobileQuery.matches) {
    openMobileSidebar();
  } else {
    setSidebarCollapsed(false);
  }
  const input = document.getElementById('sidebar-search-input');
  if (input) setTimeout(() => input.focus(), 50);
}

// --- Montaje -----------------------------------------------------------------
function setupShell() {
  if (shellReady) return;
  shellReady = true;

  // Estado inicial
  new MutationObserver(syncEmptyState).observe(emptyState, { attributes: true, attributeFilter: ['style'] });
  syncEmptyState();
  updateGreeting();
  updateUserIdentity();
  renderEffortOptions();
  setOutputStyle(selectedOutputStyle);
  applyTheme(readPref('zer0code_theme', 'light'), { persist: false });
  darkSchemeQuery.addEventListener('change', () => {
    if (readPref('zer0code_theme', 'light') === 'system') applyTheme('system', { persist: false });
  });
  adjustTextareaHeight();

  // Barra lateral
  document.getElementById('btn-collapse-sidebar')?.addEventListener('click', () => {
    if (mobileQuery.matches) closeMobileSidebar();
    else setSidebarCollapsed(true);
  });
  document.getElementById('btn-nav-personalize')?.addEventListener('click', openPersonalizeModal);
  document.getElementById('btn-nav-sync')?.addEventListener('click', () => { closeMobileSidebar(); handleSyncModels(); });
  document.getElementById('btn-nav-add-model')?.addEventListener('click', () => { closeMobileSidebar(); openCustomModelModal(); });
  const moreBtn = document.getElementById('btn-nav-more');
  const moreList = document.getElementById('nav-more-list');
  moreBtn?.addEventListener('click', () => {
    const open = moreList.hidden;
    moreList.hidden = !open;
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const searchInput = document.getElementById('sidebar-search-input');
  searchInput?.addEventListener('input', () => {
    sessionFilter = searchInput.value;
    renderSessionsList(lastSessionsList);
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      sessionFilter = '';
      renderSessionsList(lastSessionsList);
      searchInput.blur();
    }
  });

  // Incógnito
  document.getElementById('btn-incognito')?.addEventListener('click', () => setIncognito(!incognitoMode));
  window.addEventListener('pagehide', () => discardIncognitoSession({ keepalive: true }));

  // Menú "+"
  bindDropdown('dropdown-plus', 'btn-composer-plus');
  document.getElementById('btn-plus-commands')?.addEventListener('click', () => {
    promptInput.value = '/';
    promptInput.focus();
    adjustTextareaHeight();
    handlePromptInputSlash();
  });
  document.getElementById('btn-plus-folder')?.addEventListener('click', openWorkspaceModal);
  document.getElementById('btn-plus-incognito')?.addEventListener('click', () => setIncognito(!incognitoMode));

  // Proyecto, estilo y usuario
  bindDropdown('dropdown-project', 'input-ws-pill', renderProjectMenu);
  document.getElementById('btn-project-browse')?.addEventListener('click', openWorkspaceModal);

  bindDropdown('dropdown-output', 'btn-output-trigger');
  document.querySelectorAll('.output-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setOutputStyle(opt.dataset.value);
      closeAllDropdowns();
    });
  });

  bindDropdown('dropdown-user', 'btn-sidebar-user-pill', () => loadPlanLimits());
  document.getElementById('btn-edit-display-name')?.addEventListener('click', openPersonalizeModal);
  document.getElementById('user-plan-limits')?.addEventListener('click', openUsageModal);
  document.getElementById('plan-chip')?.addEventListener('click', openUsageModal);
  document.getElementById('provider-usage-chips')?.addEventListener('click', event => {
    if (event.target.closest('[data-provider-usage]')) openUsageModal();
  });
  document.getElementById('plan-alert')?.addEventListener('click', handlePlanAlertClick);
  document.getElementById('btn-user-security')?.addEventListener('click', openSecurityModal);
  document.getElementById('btn-user-admin')?.addEventListener('click', openUsersModal);
  document.getElementById('btn-close-users')?.addEventListener('click', closeUsersModal);
  document.getElementById('users-list')?.addEventListener('click', handleUsersListClick);
  document.getElementById('btn-users-secondary')?.addEventListener('click', () => {
    if (editingUser === null) closeUsersModal();
    else showUsersList();
  });
  document.getElementById('btn-users-primary')?.addEventListener('click', () => {
    if (editingUser === null) showUserForm();
    else submitUserForm();
  });
  document.getElementById('user-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitUserForm();
  });
  document.getElementById('btn-close-security')?.addEventListener('click', closeSecurityModal);
  document.getElementById('security-password-form')?.addEventListener('submit', handleSecurityPasswordSubmit);
  document.getElementById('btn-logout-all')?.addEventListener('click', handleLogoutAll);
  document.getElementById('plan-limits')?.addEventListener('click', (e) => {
    if (e.target.closest('.plan-refresh')) { loadPlanLimits(true); loadProviderUsage(true); }
  });
  document.getElementById('btn-user-personalize')?.addEventListener('click', openPersonalizeModal);
  document.getElementById('btn-user-key')?.addEventListener('click', openKeyModal);
  document.getElementById('btn-user-usage')?.addEventListener('click', openUsageModal);
  document.getElementById('btn-nav-usage')?.addEventListener('click', openUsageModal);
  document.getElementById('btn-close-usage')?.addEventListener('click', closeUsageModal);
  document.getElementById('btn-done-usage')?.addEventListener('click', closeUsageModal);
  document.getElementById('btn-reset-usage')?.addEventListener('click', handleResetUsage);
  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTheme(btn.dataset.themeChoice);
    });
  });

  // Submenú de esfuerzo
  const effortSubmenu = document.getElementById('effort-submenu');
  if (effortSubmenu) bindSubmenu(effortSubmenu);

  // Modal Personalizar
  document.getElementById('btn-close-personalize')?.addEventListener('click', () => closePersonalizeModal());
  document.getElementById('btn-cancel-personalize')?.addEventListener('click', () => closePersonalizeModal());
  document.getElementById('btn-save-personalize')?.addEventListener('click', savePersonalization);
  document.querySelectorAll('#pz-theme button').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.value, { persist: false })));
  document.querySelectorAll('#pz-accent button').forEach(b => b.addEventListener('click', () => applyAccent(b.dataset.value, { persist: false })));
  document.querySelectorAll('#pz-font button').forEach(b => b.addEventListener('click', () => applyChatFont(b.dataset.value, { persist: false })));

  // Atajos de teclado
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusSidebarSearch();
    }
    if (e.key === 'Escape') {
      closePersonalizeModal();
      closeUsageModal();
      closeSecurityModal();
      closeUsersModal();
    }
  });
}

// --- Usuario actual (rol y permisos) -------------------------------------------
function isAdminUser() {
  return !currentUser || currentUser.role === 'admin';
}

function applyCurrentUser(user) {
  currentUser = user;
  updateGreeting();
  if (user.username && user.username !== currentUsername) {
    setCurrentUsername(user.username);
    if (shellReady) updateUserIdentity();
  }
  const admin = isAdminUser();
  // Lo que solo puede tocar el admin: usuarios, catálogo de modelos y reinicio del gasto
  const usersBtn = document.getElementById('btn-user-admin');
  if (usersBtn) usersBtn.hidden = !admin;
  for (const id of ['btn-nav-add-model', 'btn-open-add-model', 'btn-reset-usage']) {
    const el = document.getElementById(id);
    if (el) el.style.display = admin ? '' : 'none';
  }
  const recovery = document.getElementById('security-recovery-hint');
  if (recovery && !admin) recovery.textContent = 'Si la olvidas, pídele al administrador que te ponga una nueva.';
  applyAllowedModes();
}

// --- Permisos de herramientas ---------------------------------------------------
const pendingPermissions = new Map();

function permissionTitle(req) {
  const { verb, target } = describeTool(req.tool, req.input);
  return { verb, target };
}

function renderPermissionDock() {
  const dock = document.getElementById('permission-dock');
  if (!dock) return;

  // Conservar las tarjetas ya pintadas (y lo que se esté escribiendo en ellas)
  for (const card of dock.querySelectorAll('.permission-card')) {
    if (!pendingPermissions.has(card.dataset.id) && !card.classList.contains('is-settled')) card.remove();
  }
  for (const req of pendingPermissions.values()) {
    if (dock.querySelector(`.permission-card[data-id="${CSS.escape(req.id)}"]`)) continue;
    dock.appendChild(buildPermissionCard(req));
    markToolCardWaiting(req.toolUseId, true);
  }
  dock.hidden = dock.children.length === 0;
  if (!dock.hidden) scrollToBottom();
}

function buildPermissionCard(req) {
  const { verb, target } = permissionTitle(req);
  const otherChat = req.sessionId && activeSessionId && req.sessionId !== activeSessionId;
  const card = document.createElement('div');
  card.className = 'permission-card';
  card.dataset.id = req.id;
  card.innerHTML = `
    <div class="permission-head">
      <svg class="permission-icon"><use href="#i-shield"/></svg>
      <div class="permission-title">
        <strong>Zer0 pide permiso</strong>
        <span>${escapeHtml(verb)}${target ? ` <code>${escapeHtml(target)}</code>` : ''}</span>
        ${otherChat ? '<span class="permission-note">En otra conversación</span>' : ''}
      </div>
    </div>
    <details class="permission-detail">
      <summary>Ver detalles</summary>
      ${toolDetailHtml(req.tool, req.input)}
    </details>
    <div class="permission-actions">
      <button type="button" class="btn-text" data-action="deny">Denegar</button>
      <button type="button" class="btn-text" data-action="always" title="No volverá a preguntar por ${escapeHtml(req.tool)} en esta conversación">Permitir siempre ${escapeHtml(req.tool)}</button>
      <button type="button" class="btn-primary-terracotta" data-action="allow">Permitir</button>
    </div>
  `;
  card.querySelector('.permission-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    respondPermission(req.id, action !== 'deny', action === 'always');
  });
  return card;
}

function respondPermission(id, allow, always = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Sin conexión con el servidor: vuelve a intentarlo en un momento');
    return;
  }
  ws.send(JSON.stringify({ type: 'permission_response', id, allow, always }));
  const card = document.querySelector(`.permission-card[data-id="${CSS.escape(id)}"]`);
  card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
}

// El servidor confirma la respuesta (desde este u otro dispositivo, o porque la tarea terminó)
function settlePermissionCard(id, allowed) {
  const req = pendingPermissions.get(id);
  pendingPermissions.delete(id);
  if (req) markToolCardWaiting(req.toolUseId, false);
  const dock = document.getElementById('permission-dock');
  const card = dock?.querySelector(`.permission-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add('is-settled', allowed ? 'is-allowed' : 'is-denied');
  card.querySelector('.permission-actions').innerHTML = `<span class="permission-result">${allowed ? 'Permitido' : 'Denegado'}</span>`;
  setTimeout(() => {
    card.remove();
    dock.hidden = dock.children.length === 0;
  }, 1200);
}

function markToolCardWaiting(toolUseId, waiting) {
  const card = toolUseId ? currentToolCards.get(toolUseId) : null;
  if (card) card.classList.toggle('is-waiting', waiting);
}

// --- Gestión de usuarios (admin) ----------------------------------------------
let usersCache = [];
let editingUser = null; // null = lista; '' = nuevo; nombre = editando

async function openUsersModal() {
  closeAllDropdowns();
  closeMobileSidebar();
  document.getElementById('users-modal').style.display = 'flex';
  showUsersList();
  try {
    const res = await authFetch('/api/users');
    const data = await res.json();
    if (data.success) {
      usersCache = data.users;
      renderUsersList();
    } else {
      document.getElementById('users-list').innerHTML = `<div class="usage-empty">${escapeHtml(data.error || 'No se pudieron cargar los usuarios')}</div>`;
    }
  } catch (err) {
    document.getElementById('users-list').innerHTML = '<div class="usage-empty">No se pudieron cargar los usuarios</div>';
  }
}

function closeUsersModal() {
  const modal = document.getElementById('users-modal');
  if (modal) modal.style.display = 'none';
}

function showUsersList() {
  editingUser = null;
  document.getElementById('users-modal-title').textContent = 'Usuarios';
  document.getElementById('users-list-view').hidden = false;
  document.getElementById('user-form').hidden = true;
  document.getElementById('btn-users-secondary').textContent = 'Cerrar';
  document.getElementById('btn-users-primary').textContent = 'Nuevo usuario';
}

const MODE_SHORT_LABELS = { manual: 'Manual', acceptEdits: 'Aceptar ediciones', plan: 'Plan', auto: 'Autónomo' };

function renderUsersList() {
  const list = document.getElementById('users-list');
  if (!usersCache.length) {
    list.innerHTML = '<div class="usage-empty">Todavía no hay usuarios</div>';
    return;
  }
  list.innerHTML = usersCache.map(u => {
    const admin = u.role === 'admin';
    const limit = u.monthlyLimitUSD === null || u.monthlyLimitUSD === undefined
      ? 'Sin límite'
      : `${formatUsd(u.monthSpentUSD || 0)} de ${formatUsd(u.monthlyLimitUSD)} este mes`;
    return `
      <div class="user-row" data-username="${escapeHtml(u.username)}">
        <div class="user-row-main">
          <div class="user-row-name">
            ${escapeHtml(u.username)}
            <span class="user-role-chip${admin ? ' is-admin' : ''}">${admin ? 'Admin' : 'Usuario'}</span>
            ${u.mustChangePassword && !admin ? '<span class="user-role-chip">Contraseña temporal</span>' : ''}
          </div>
          <div class="user-row-meta">
            ${admin
              ? 'Acceso completo · se configura desde el .env'
              : `${u.roots.map(r => `<code>${escapeHtml(r)}</code>`).join(' ')}<br>${u.allowedModes.map(m => escapeHtml(MODE_SHORT_LABELS[m] || m)).join(' · ')} · ${escapeHtml(limit)}`}
          </div>
        </div>
        ${admin ? '' : `
          <div class="user-row-actions">
            <button type="button" class="btn-text" data-action="edit">Editar</button>
            <button type="button" class="btn-text security-danger" data-action="delete">Eliminar</button>
          </div>`}
      </div>`;
  }).join('');
}

async function handleUsersListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const username = btn.closest('.user-row')?.dataset.username;
  if (!username) return;

  if (btn.dataset.action === 'edit') {
    showUserForm(usersCache.find(u => u.username === username));
    return;
  }

  // Eliminar: confirmación en el propio botón
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Seguro? Borra también sus chats';
    return;
  }
  try {
    const res = await authFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      usersCache = data.users;
      renderUsersList();
      showToast(`Usuario ${username} eliminado`);
    } else {
      showToast(data.error || 'No se pudo eliminar el usuario');
    }
  } catch (err) {
    showToast('No se pudo eliminar el usuario');
  }
}

function showUserForm(user = null) {
  editingUser = user ? user.username : '';
  const isNew = !user;
  document.getElementById('users-modal-title').textContent = isNew ? 'Nuevo usuario' : `Editar ${user.username}`;
  document.getElementById('users-list-view').hidden = true;
  const form = document.getElementById('user-form');
  form.hidden = false;
  form.reset();

  const nameInput = document.getElementById('user-form-name');
  nameInput.value = user ? user.username : '';
  nameInput.disabled = !isNew;
  document.getElementById('user-form-password-label').textContent = isNew ? 'Contraseña temporal' : 'Nueva contraseña';
  document.getElementById('user-form-password').placeholder = isNew ? 'Mínimo 8 caracteres' : 'Déjalo vacío para no cambiarla';
  document.getElementById('user-form-password-hint').textContent = isNew
    ? 'Tendrá que cambiarla la primera vez que entre.'
    : 'Si pones una, se cerrarán sus sesiones y tendrá que cambiarla al entrar.';
  document.getElementById('user-form-roots').value = user ? user.roots.join('\n') : (currentWorkspace || '');
  const modes = user ? user.allowedModes : ['manual', 'acceptEdits', 'plan'];
  document.querySelectorAll('#user-form-modes input').forEach(cb => { cb.checked = modes.includes(cb.value); });
  document.getElementById('user-form-limit').value = user && user.monthlyLimitUSD !== null ? user.monthlyLimitUSD : '';
  document.getElementById('user-form-status').style.display = 'none';

  document.getElementById('btn-users-secondary').textContent = 'Volver';
  document.getElementById('btn-users-primary').textContent = isNew ? 'Crear usuario' : 'Guardar cambios';
  (isNew ? nameInput : document.getElementById('user-form-roots')).focus();
}

function setUserFormStatus(message) {
  const box = document.getElementById('user-form-status');
  box.className = 'key-status-box error';
  box.textContent = message;
  box.style.display = 'flex';
}

async function submitUserForm() {
  const isNew = editingUser === '';
  const password = document.getElementById('user-form-password').value;
  const limitRaw = document.getElementById('user-form-limit').value.trim();
  const body = {
    roots: document.getElementById('user-form-roots').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    allowedModes: [...document.querySelectorAll('#user-form-modes input:checked')].map(cb => cb.value),
    monthlyLimitUSD: limitRaw === '' ? null : Number(limitRaw)
  };
  if (isNew) {
    body.username = document.getElementById('user-form-name').value.trim();
    body.password = password;
  } else if (password) {
    body.password = password;
  }

  try {
    const res = await authFetch(isNew ? '/api/users' : `/api/users/${encodeURIComponent(editingUser)}`, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.success) {
      setUserFormStatus(data.error || 'No se pudo guardar el usuario');
      return;
    }
    usersCache = data.users;
    showToast(isNew ? `Usuario ${data.user.username} creado` : 'Cambios guardados');
    showUsersList();
    renderUsersList();
  } catch (err) {
    setUserFormStatus('Error al conectar con el servidor');
  }
}

// Boot check
window.addEventListener('DOMContentLoaded', checkAuth);

// ==========================================================================
// App instalable (PWA) y notificaciones push
// ==========================================================================
let deferredInstallPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// App de Android (WebView): expone window.Zer0CodeAndroid para volver a la pantalla de elegir servidor
function inAndroidApp() {
  return typeof window.Zer0CodeAndroid?.changeServer === 'function';
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker no registrado:', err));
  // Tocar una notificación con la app ya abierta
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open_session' && event.data.sessionId && authToken) openSession(event.data.sessionId);
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (document.getElementById('app-modal')?.style.display === 'flex') renderAppModal();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  showToast('App instalada');
  renderAppModal();
});

// Quitar las notificaciones ya mostradas al volver a la app
function clearShownNotifications() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration()
    .then(reg => reg ? reg.getNotifications() : [])
    .then(list => list.forEach(n => n.close()))
    .catch(() => {});
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function base64UrlToUint8Array(value) {
  const base64 = (value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Has bloqueado las notificaciones para esta web');
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await authFetch('/api/push/key');
  const { publicKey } = await keyRes.json();
  let sub = await reg.pushManager.getSubscription();
  // Si el servidor cambió de claves, la suscripción antigua ya no sirve
  if (sub && sub.options?.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const expected = base64UrlToUint8Array(publicKey);
    if (current.length !== expected.length || current.some((b, i) => b !== expected[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) });
  }
  const res = await authFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() })
  });
  if (!res.ok) throw new Error('El servidor no ha aceptado la suscripción');
}

async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  if (authToken) {
    await authFetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint })
    }).catch(() => {});
  }
  await sub.unsubscribe();
}

async function renderAppModal() {
  const installHint = document.getElementById('app-install-hint');
  const installBtn = document.getElementById('btn-app-install');
  const pushHint = document.getElementById('app-push-hint');
  const pushBtn = document.getElementById('btn-app-push');
  if (!installHint || !pushHint) return;

  installBtn.hidden = true;
  installBtn.textContent = 'Instalar app';
  delete installBtn.dataset.action;
  const versionSection = document.getElementById('app-version-section');
  const appVersion = inAndroidApp() && typeof window.Zer0CodeAndroid.appVersion === 'function' ? window.Zer0CodeAndroid.appVersion() : '';
  if (versionSection) versionSection.hidden = !appVersion;
  if (appVersion) document.getElementById('app-version-hint').textContent = `Tienes Zer0Code ${appVersion} para Android. Mira qué hay de nuevo y actualiza la app desde aquí.`;
  if (inAndroidApp()) {
    installHint.textContent = 'Estás usando la app de Android, conectada a este servidor.';
    installBtn.textContent = 'Cambiar de servidor';
    installBtn.dataset.action = 'change-server';
    installBtn.hidden = false;
    pushHint.innerHTML = 'La app de Android no recibe notificaciones push. Si quieres los avisos, instala Zer0Code desde <strong>Chrome</strong> (menú ⋮ → <em>Instalar aplicación</em>).';
    pushBtn.hidden = true;
    return;
  }
  if (!window.isSecureContext) {
    installHint.innerHTML = 'Para instalarla hace falta abrir Zer0Code por <strong>HTTPS</strong>. Instálala en el servidor con <code>bash deploy/install-linux.sh --tailscale</code> y entra por la dirección <code>https://…ts.net</code>.';
  } else if (isStandalone()) {
    installHint.textContent = 'Ya la estás usando como app instalada.';
  } else if (deferredInstallPrompt) {
    installHint.textContent = 'Añade Zer0Code a tu pantalla de inicio: se abre a pantalla completa, como una app más.';
    installBtn.hidden = false;
  } else if (isIos()) {
    installHint.innerHTML = 'En Safari, toca <strong>Compartir</strong> y después <strong>Añadir a pantalla de inicio</strong>. En iPhone las notificaciones solo funcionan desde la app instalada.';
  } else {
    installHint.innerHTML = 'Abre el menú del navegador y elige <strong>Instalar aplicación</strong> (o <strong>Añadir a pantalla de inicio</strong>).';
  }

  pushBtn.hidden = true;
  if (!window.isSecureContext) {
    pushHint.textContent = 'Las notificaciones también necesitan HTTPS.';
  } else if (!pushSupported()) {
    pushHint.textContent = isIos() && !isStandalone()
      ? 'Instala la app primero (paso anterior) y actívalas desde ella.'
      : 'Este navegador no admite notificaciones push.';
  } else if (Notification.permission === 'denied') {
    pushHint.textContent = 'Las has bloqueado para esta web. Actívalas en los ajustes del navegador o del móvil y vuelve aquí.';
  } else {
    const sub = await currentPushSubscription().catch(() => null);
    const on = !!sub && Notification.permission === 'granted';
    pushHint.textContent = on
      ? 'Activadas en este dispositivo: te avisa cuando Zer0 termina o necesita permiso y no tienes la app a la vista.'
      : 'Recibe un aviso cuando Zer0 termine una tarea o necesite tu permiso, aunque tengas la app cerrada.';
    pushBtn.textContent = on ? 'Desactivar en este dispositivo' : 'Activar notificaciones';
    pushBtn.dataset.on = on ? '1' : '';
    pushBtn.hidden = false;
  }
}

function openAppModal() {
  closeAllDropdowns();
  closeMobileSidebar();
  document.getElementById('app-modal').style.display = 'flex';
  renderAppModal();
}

function closeAppModal() {
  document.getElementById('app-modal').style.display = 'none';
}

function setupAppInstall() {
  // En la app de Android el menú enseña la versión instalada
  const androidVersion = inAndroidApp() && typeof window.Zer0CodeAndroid.appVersion === 'function' ? window.Zer0CodeAndroid.appVersion() : '';
  const appRowLabel = document.querySelector('#btn-user-app span');
  if (androidVersion && appRowLabel) appRowLabel.textContent = `App y novedades · v${androidVersion}`;
  document.getElementById('btn-user-app')?.addEventListener('click', openAppModal);
  document.getElementById('btn-close-app')?.addEventListener('click', closeAppModal);
  document.getElementById('app-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'app-modal') closeAppModal();
  });

  document.getElementById('btn-app-install')?.addEventListener('click', async (e) => {
    if (e.currentTarget.dataset.action === 'change-server') {
      window.Zer0CodeAndroid.changeServer();
      return;
    }
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    renderAppModal();
  });

  document.getElementById('btn-app-whatsnew')?.addEventListener('click', () => {
    // Apps anteriores sin la hoja de novedades: al menos buscan actualizaciones
    if (typeof window.Zer0CodeAndroid?.showWhatsNew === 'function') window.Zer0CodeAndroid.showWhatsNew();
    else window.Zer0CodeAndroid?.checkUpdates?.();
    closeAppModal();
  });

  document.getElementById('btn-app-push')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (btn.dataset.on) {
        await disablePush();
        showToast('Notificaciones desactivadas');
      } else {
        await enablePush();
        showToast('Notificaciones activadas');
      }
    } catch (err) {
      showToast(err.message || 'No se pudieron activar las notificaciones');
    } finally {
      btn.disabled = false;
      renderAppModal();
    }
  });
}


// Sincronización entre dispositivos: varios avisos seguidos se juntan en una sola descarga de la lista
let sessionsRefreshTimer = null;
function scheduleSessionsRefresh() {
  clearTimeout(sessionsRefreshTimer);
  sessionsRefreshTimer = setTimeout(async () => {
    try {
      const res = await authFetch('/api/sessions');
      const data = await res.json();
      const sessions = data.sessions || [];
      renderSessionsList(sessions);
      // La conversación abierta se borró en otro dispositivo
      if (activeSessionId && !incognitoMode && !isRunning && !sessions.some(s => s.id === activeSessionId)) {
        newChat();
        showToast('Esta conversación se eliminó en otro dispositivo');
      }
    } catch (e) {
      // se reintenta con el siguiente aviso
    }
  }, 250);
}
