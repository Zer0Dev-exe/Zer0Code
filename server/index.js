import './env.js';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  getCurrentWorkspace,
  setWorkspace,
  listDirectory,
  createDirectory,
  getQuickLocations,
  forgetUserWorkspace
} from './workspaceManager.js';

import { getPublicProfile, getProfilePrompt, getProfileIdentity, setProfileDisplayName } from './profiles.js';
import { resolveIdentityProfile } from './identityProfile.js';
import { getIdentityAccount } from './identityAccount.js';
import { getProviderUsage, summarizeProviderUsage } from './providerUsage.js';
import { getPushPublicKey, addSubscription, removeSubscription, forgetUserPush, notifyUser } from './pushManager.js';

import { isRestricted, isPathAllowed, isModeAllowed, toolPathViolation } from './accessPolicy.js';
import { DATA_DIR } from './paths.js';
import { getGitChanges, getGitSummary } from './gitInfo.js';

import {
  setPermissionNotifier,
  registerTask,
  unregisterTask,
  requestPermission,
  answerPermission,
  listPendingFor,
  forgetChat,
  runTaskAction
} from './permissionManager.js';
import { createProject, projectToolHint, isProjectEdit } from './projectCreator.js';
import { listTools, installTool, uninstallTool, setToolsNotifier, TOOL_IDS, toolAvailable, toolLabel } from './toolsManager.js';

import {
  getClaudeAuthStatus,
  cancelActiveTask,
  isTaskActive,
  getAppMode,
  validateApiKey,
  deleteClaudeTranscript,
  reviewKey
} from './claudeRunner.js';

import {
  getOrchestrationConfig,
  setOrchestrationConfig,
  forgetUserOrchestration,
  recommendRoles,
  resolveReviewer,
  createReviewController,
  reviewerPermissionPolicy,
  autoFixPrompt,
  EDIT_TOOLS
} from './orchestrator.js';

import {
  getAvailableModels,
  addOrUpdateModel,
  deleteCustomModel,
  syncModelsFromAnthropic,
  withPricing,
  getDefaultModelId,
  getHostOAuthToken
} from './modelsManager.js';

import { refreshPricing, getPricingInfo } from './pricingManager.js';
import { PROVIDERS, providerOf, getProviderModels, getProvidersStatus, executeWithProvider, setGeminiBackend, waitForCodexCatalog, onCodexCatalogUpdated } from './providers.js';
import {
  summarizeResultCost,
  recordUsage,
  getUsage,
  resetUsage,
  getPlanLimits,
  getMonthCost,
  forgetUserUsage
} from './usageManager.js';

import {
  login,
  getUserFromToken,
  logout,
  logoutAll,
  changePassword,
  requireAuth,
  requireAuthAllowDefault,
  requireAdmin,
  tokenFromRequest,
  getAdminUsername,
  isUsingDefaultPassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser
} from './auth.js';

import {
  getAllSessions,
  getSession,
  createSession,
  addMessageToSession,
  setClaudeSessionId,
  getProviderSessionId,
  setProviderSessionId,
  getReviewerSessionId,
  setReviewerSessionId,
  deleteSession,
  assignLegacyOwner,
  deleteSessionsByOwner,
  moveSession
} from './sessionManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();
const server = http.createServer(app);
// Solo se aceptan conexiones WebSocket desde la propia web (evita que otra página abra una)
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }) => {
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
});

const PORT = process.env.PORT || 5050;
// HOST=127.0.0.1 para que solo se pueda entrar desde este PC (p. ej. si usas Tailscale)
const HOST = process.env.HOST || '0.0.0.0';

// Cabeceras de seguridad básicas
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Solo el micrófono (dictado por voz) para esta web; nada de cámara, ubicación, pagos ni USB
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Por HTTPS (directo o detrás de Cloudflare/Tailscale), el navegador no vuelve a intentar HTTP
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});

/**
 * Content-Security-Policy de las páginas de la web y de la interfaz de escritorio. Los únicos scripts que
 * se ejecutan son los del propio servidor y los <script> en línea de la página (por su hash): un HTML
 * inyectado no puede cargar ni ejecutar código. Las imágenes pueden venir de fuera (avatares).
 */
function pageCsp(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    // El navegador convierte CRLF y CR sueltos en LF antes de calcular el hash (p. ej. un checkout de
    // Windows con core.autocrlf): se hace lo mismo para que coincida
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    // La interfaz de escritorio lee las novedades de GitHub
    "connect-src 'self' ws: wss: https://api.github.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

assignLegacyOwner(getAdminUsername());

// --------------------------------------------------------------------------
// Permisos de herramientas: el servidor MCP (permissionMcp.js) que lanza Claude Code llama aquí
// y la petición espera a que el usuario responda desde la web. Va antes del parser global
// porque el input de una herramienta (p. ej. Write) puede superar su límite de tamaño.
// --------------------------------------------------------------------------
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

app.post('/internal/permission', express.json({ limit: '20mb' }), async (req, res) => {
  const secret = req.headers['x-zer0code-secret'];
  if (!LOOPBACK.has(req.socket.remoteAddress) || typeof secret !== 'string') {
    return res.status(403).json({ behavior: 'deny', message: 'No autorizado' });
  }
  const decision = await requestPermission(secret, req.body || {});
  res.json(decision);
});

// Herramientas de Zer0Code que usa el modelo desde el mismo servidor MCP (p. ej. crear un proyecto)
app.post('/internal/action', express.json({ limit: '1mb' }), async (req, res) => {
  const secret = req.headers['x-zer0code-secret'];
  if (!LOOPBACK.has(req.socket.remoteAddress) || typeof secret !== 'string') {
    return res.status(403).json({ ok: false, error: 'No autorizado' });
  }
  res.json(await runTaskAction(secret, String(req.body?.action || ''), req.body?.args));
});

app.use(express.json());
// Cada instalación es su propia app: el nombre sale del .env de este servidor (APP_NAME) y la
// app instalada solo habla con él. Nada de este servidor (claves, usuarios) va en el repositorio.
const APP_NAME = (process.env.APP_NAME || 'Zer0Code').trim().slice(0, 40) || 'Zer0Code';
const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

app.get('/manifest.json', (req, res) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'public', 'manifest.json'), 'utf-8'));
  manifest.name = APP_NAME;
  manifest.short_name = APP_NAME.length > 12 ? APP_NAME.slice(0, 12).trim() : APP_NAME;
  res.type('application/manifest+json').send(JSON.stringify(manifest));
});

// Versión de un archivo estático según su fecha de cambio: así Cloudflare y el navegador no sirven uno viejo
const assetVersion = (file) => Math.floor(fs.statSync(path.join(projectRoot, 'public', file)).mtimeMs).toString(36);

app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf-8')
    .replace('href="css/style.css"', `href="css/style.css?v=${assetVersion('css/style.css')}"`)
    .replace('src="js/app.js"', `src="js/app.js?v=${assetVersion('js/app.js')}"`)
    .replace('<title>Zer0Code</title>', `<title>${escapeAttr(APP_NAME)}</title>`)
    .replace('<span class="brand-text">Zer0Code</span>', `<span class="brand-text">${escapeAttr(APP_NAME)}</span>`)
    .replace('<h1 class="login-title">Zer0Code</h1>', `<h1 class="login-title">${escapeAttr(APP_NAME)}</h1>`)
    .replace('name="apple-mobile-web-app-title" content="Zer0Code"', `name="apple-mobile-web-app-title" content="${escapeAttr(APP_NAME)}"`);
  res.set('Content-Security-Policy', pageCsp(html)).type('html').send(html);
});

// Interfaz de escritorio (la carga la app en /desktop/): misma política
app.get(['/desktop/', '/desktop/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'desktop', 'index.html'), 'utf-8');
  res.set({ 'Content-Security-Policy': pageCsp(html), 'Cache-Control': 'no-cache' }).type('html').send(html);
});

// Librerías de la web servidas por este mismo servidor (antes venían de un CDN sin versión fija):
// el Markdown de las respuestas se convierte con marked y se limpia con DOMPurify antes de pintarlo
const VENDOR_FILES = {
  'marked.js': path.join(projectRoot, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
  'purify.js': path.join(projectRoot, 'node_modules', 'dompurify', 'dist', 'purify.min.js')
};
app.get('/vendor/:file', (req, res) => {
  const file = VENDOR_FILES[req.params.file];
  if (!file) return res.status(404).end();
  // La ruta es fija (de la lista de arriba): se permite aunque el proyecto esté en una carpeta oculta
  res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').sendFile(file, { dotfiles: 'allow' });
});

// Librerías de la web servidas por este mismo servidor (antes venían de un CDN sin versión fija):
// el Markdown de las respuestas se convierte con marked y se limpia con DOMPurify antes de pintarlo
const VENDOR_FILES = {
  'marked.js': path.join(projectRoot, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
  'purify.js': path.join(projectRoot, 'node_modules', 'dompurify', 'dist', 'purify.min.js')
};
app.get('/vendor/:file', (req, res) => {
  const file = VENDOR_FILES[req.params.file];
  if (!file) return res.status(404).end();
  // La ruta es fija (de la lista de arriba): se permite aunque el proyecto esté en una carpeta oculta
  res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').sendFile(file, { dotfiles: 'allow' });
});

app.use(express.static(path.join(projectRoot, 'public')));

// Enviar a todos los dispositivos autenticados (datos comunes: catálogo de modelos, límites del plan)
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(json);
    }
  }
}

// Enviar solo a los dispositivos de un usuario (sus conversaciones, tareas y permisos)
function sendToUser(username, data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.username === username) {
      client.send(json);
    }
  }
}

function closeUserSockets(username, { exceptToken = null } = {}) {
  for (const client of wss.clients) {
    if (client.username === username && client.authToken !== exceptToken) client.close(4001, 'Sesión cerrada');
  }
}

// ¿Tiene el usuario la web abierta y a la vista en algún dispositivo? Entonces no hace falta push
function userIsWatching(username) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.username === username && client.visible) {
      return true;
    }
  }
  return false;
}

// Notificar al móvil solo si no está mirando la web (el service worker siempre tiene que mostrarla)
function pushIfAway(username, payload) {
  if (!userIsWatching(username)) notifyUser(username, payload);
}

// Avisos de permiso: a la web abierta y, por push, al móvil aunque la app esté cerrada
// Progreso de la instalación de herramientas: a todos (las cuentas dependen de ellas)
setToolsNotifier((data) => broadcast(data));

setPermissionNotifier((username, data) => {
  sendToUser(username, data);
  if (data.type === 'permission_request' && data.request) {
    const chat = getSession(data.request.sessionId, username);
    const title = chat && !chat.incognito ? chat.title : null;
    pushIfAway(username, {
      title: 'Zer0 necesita permiso',
      body: `${data.request.tool}${title ? ` · ${title}` : ''}`,
      tag: `permission-${data.request.id}`,
      sessionId: data.request.sessionId
    });
  }
});

// Resumen corto de la respuesta para la notificación
const CONTEXT_MAX_CHARS = 12000;

/**
 * Añadir al prompt la parte del chat que este proveedor no ha visto: todo si empieza sesión nueva,
 * o lo que otro modelo respondió desde su último turno si retoma la suya
 */
function withChatContext(prompt, messages, provider, resuming) {
  let start = 0;
  if (resuming) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && (m.provider || 'claude') === provider) {
        start = i + 1;
        break;
      }
    }
  }
  const unseen = messages.slice(start).filter(m => m.text && m.text.trim());
  if (!unseen.length) return prompt;
  let context = unseen
    .map(m => `${m.role === 'user' ? 'Usuario' : `Asistente (${PROVIDERS[m.provider || 'claude']?.name || 'otro modelo'})`}: ${m.text.trim()}`)
    .join('\n\n');
  if (context.length > CONTEXT_MAX_CHARS) context = '…' + context.slice(-CONTEXT_MAX_CHARS);
  return `[Contexto: mensajes anteriores de esta conversación, algunos respondidos por otro modelo]\n${context}\n\n[Mensaje nuevo del usuario]\n${prompt}`;
}

function notificationBody(text, fallback) {
  const clean = String(text || '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 140 ? clean.slice(0, 140) + '…' : clean;
}

// Respuesta en curso de cada usuario. La tarea no depende de la conexión: si el usuario cierra
// la web o el móvil corta el WebSocket, Claude sigue trabajando y al volver se recupera lo hecho.
// seq numera los eventos para que la web descarte los que ya vienen en la instantánea.
const liveTasks = new Map();

function liveTaskFor(owner, sessionId = null) {
  const live = liveTasks.get(owner);
  if (!live || (sessionId && live.sessionId !== sessionId)) return null;
  return { sessionId: live.sessionId, seq: live.seq, message: live.message };
}

// Enviar un evento de la tarea en curso numerado con su seq
function sendTaskEvent(owner, data) {
  const live = liveTasks.get(owner);
  if (live && live.sessionId === data.sessionId) data.seq = ++live.seq;
  sendToUser(owner, data);
}

// Dirección a la que llama el servidor MCP de permisos (siempre en este mismo equipo)
function permissionCallbackUrl(route = 'permission') {
  const host = !HOST || HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `http://${host.includes(':') ? `[${host}]` : host}:${PORT}/internal/${route}`;
}

// Límite mensual del usuario con la cuenta del anfitrión (null = sin límite o no aplica)
function monthlyLimitStatus(user, usingOwnKey) {
  if (!isRestricted(user) || usingOwnKey || user.monthlyLimitUSD === null) return null;
  const spent = getMonthCost(user.username);
  return { limitUSD: user.monthlyLimitUSD, spentUSD: spent, reached: spent >= user.monthlyLimitUSD };
}

// Datos del usuario que necesita la web
function userInfo(user) {
  return {
    username: user.username,
    role: user.role,
    allowedModes: user.allowedModes,
    roots: user.roots,
    monthlyLimitUSD: user.monthlyLimitUSD,
    monthSpentUSD: isRestricted(user) ? getMonthCost(user.username) : null,
    profile: getPublicProfile(user.username)
  };
}

// --------------------------------------------------------------------------
// Auth Endpoints
// --------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password, req);
  if (result.success) {
    res.json(result);
  } else {
    res.status(result.locked ? 429 : 401).json(result);
  }
});

app.get('/api/auth/verify', (req, res) => {
  const user = getUserFromToken(tokenFromRequest(req));
  if (user) {
    res.json({ success: true, username: user.username, mustChangePassword: user.mustChangePassword, user: userInfo(user) });
  } else {
    res.status(401).json({ success: false });
  }
});

app.get('/api/profile', requireAuth, async (req, res) => {
  const account = await getIdentityAccount(req.user, getAppMode());
  const profile = await resolveIdentityProfile(req.user, { account, configured: getProfileIdentity(req.user.username) });
  res.json({ success: true, profile });
});

app.get('/api/usage/providers', requireAuth, async (req, res) => {
  res.json(await getProviderUsage(req.user.username, {
    force: req.query.refresh === '1',
    apiKey: getAppMode() === 'Client' || !!req.headers['x-claude-api-key']
  }));
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  let configured;
  try {
    configured = setProfileDisplayName(req.user.username, req.body?.displayName);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ success: false, error: error.message });
    throw error;
  }
  const account = await getIdentityAccount(req.user, getAppMode());
  const profile = await resolveIdentityProfile(req.user, { account, configured });
  res.json({ success: true, profile });
});

app.post('/api/auth/change-password', requireAuthAllowDefault, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const result = changePassword(req.userToken, currentPassword, newPassword);
  if (result.success) {
    // Echar a los WebSocket de las sesiones que se acaban de cerrar
    closeUserSockets(req.user.username, { exceptToken: req.userToken });
  }
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/auth/logout', requireAuthAllowDefault, (req, res) => {
  logout(req.userToken);
  for (const client of wss.clients) {
    if (client.authToken === req.userToken) client.close(4001, 'Sesión cerrada');
  }
  res.json({ success: true });
});

// Cerrar sesión en todos los dispositivos del usuario (incluido este)
app.post('/api/auth/logout-all', requireAuthAllowDefault, (req, res) => {
  logoutAll(req.user.username);
  closeUserSockets(req.user.username);
  res.json({ success: true });
});

// --------------------------------------------------------------------------
// Gestión de usuarios (solo admin)
// --------------------------------------------------------------------------
function usersWithUsage() {
  return listUsers().map(u => ({ ...u, monthSpentUSD: getMonthCost(u.username) }));
}

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ success: true, users: usersWithUsage() });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const user = createUser(req.body || {});
    res.json({ success: true, user, users: usersWithUsage() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  try {
    const { password, roots, allowedModes, monthlyLimitUSD } = req.body || {};
    const user = updateUser(req.params.username, { password, roots, allowedModes, monthlyLimitUSD });
    if (password) closeUserSockets(user.username);
    else sendToUser(user.username, { type: 'user_updated', user: userInfo(user) });
    res.json({ success: true, user, users: usersWithUsage() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;
  cancelOwnerTask(username);
  if (!deleteUser(username)) {
    return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
  }
  closeUserSockets(username);
  for (const s of deleteSessionsByOwner(username)) {
    forgetChat(s.id);
    if (s.claudeSessionId) deleteClaudeTranscript(s.claudeSessionId);
  }
  forgetUserWorkspace(username);
  forgetUserUsage(username);
  forgetUserPush(username);
  forgetUserOrchestration(username);
  res.json({ success: true, users: usersWithUsage() });
});

// --------------------------------------------------------------------------
// Application Endpoints (Protected by Auth)
// --------------------------------------------------------------------------
app.get('/api/status', requireAuth, async (req, res) => {
  await waitForCodexCatalog();
  const clientKey = req.headers['x-claude-api-key'] || req.query.apiKey || null;
  const appMode = getAppMode();
  const auth = getClaudeAuthStatus(clientKey);
  res.json({
    status: 'ok',
    appMode,
    auth,
    user: userInfo(req.user),
    currentWorkspace: getCurrentWorkspace(req.user),
    isTaskActive: isTaskActive(req.user.username),
    providers: getProvidersStatus(),
    availableModels: catalog(getAvailableModels()),
    defaultModel: getDefaultModelId()
  });
});

// Herramientas de IA opcionales (Claude Code, Codex, Gemini CLI): se instalan desde Ajustes
app.get('/api/tools', requireAuth, (req, res) => {
  res.json({ tools: listTools(), canManage: req.user.role === 'admin' });
});

app.post('/api/tools/:id/install', requireAuth, requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!TOOL_IDS.includes(id)) return res.status(404).json({ success: false, error: 'Herramienta desconocida' });
  // La descarga sigue en segundo plano; el progreso llega por WebSocket (tool_install)
  installTool(id).catch((err) => console.error(`No se pudo instalar ${id}:`, err.message));
  res.json({ success: true });
});

app.delete('/api/tools/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    uninstallTool(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Catálogo completo: modelos de Claude (con su tarifa) + los de ChatGPT y Gemini
function catalog(claudeModels) {
  return [...withPricing(claudeModels), ...getProviderModels()];
}

onCodexCatalogUpdated(() => {
  broadcast({ type: 'models_updated', models: catalog(getAvailableModels()), defaultModel: getDefaultModelId() });
});

// Dynamic Models Management Endpoints
app.get('/api/models', requireAuth, async (req, res) => {
  await waitForCodexCatalog();
  res.json({
    success: true,
    models: catalog(getAvailableModels()),
    defaultModel: getDefaultModelId()
  });
});

// Con qué CLI se usa Gemini: Antigravity o Gemini CLI
app.post('/api/providers/gemini-backend', requireAuth, requireAdmin, (req, res) => {
  try {
    setGeminiBackend(req.body?.backend);
    res.json({
      success: true,
      providers: getProvidersStatus(),
      models: catalog(getAvailableModels()),
      defaultModel: getDefaultModelId()
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/models', requireAuth, requireAdmin, (req, res) => {
  try {
    const { id, name, tag, badge, desc, icon } = req.body || {};
    const model = addOrUpdateModel({ id, name, tag, badge, desc, icon });
    res.json({ success: true, model, models: catalog(getAvailableModels()) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/models/:id', requireAuth, requireAdmin, (req, res) => {
  const ok = deleteCustomModel(req.params.id);
  res.json({ success: ok, models: catalog(getAvailableModels()) });
});

/**
 * Credencial para consultar /v1/models: la clave del cliente si la hay; en modo Hoster,
 * además, la ANTHROPIC_API_KEY del .env o la sesión OAuth del CLI del anfitrión.
 * En modo Client nunca se usan las credenciales del anfitrión.
 */
function resolveModelsCredential(clientKey = null) {
  if (clientKey && clientKey.trim()) return { apiKey: clientKey.trim() };
  if (getAppMode() === 'Client') return null;
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) return { apiKey: envKey.trim() };
  const oauthToken = getHostOAuthToken();
  return oauthToken ? { oauthToken } : null;
}

async function runModelsSync(clientKey = null, reason = 'manual') {
  await refreshPricing();
  const result = await syncModelsFromAnthropic(resolveModelsCredential(clientKey));
  if (result.models) result.models = catalog(result.models);
  if (result.success) {
    const changes = result.addedCount || result.removedCount
      ? ` (+${result.addedCount} / -${result.removedCount})`
      : ' (sin cambios)';
    console.log(`[modelos] Sincronizados desde Anthropic [${reason}]: ${result.models.map(m => m.id).join(', ')}${changes}`);
    if (result.addedCount || result.removedCount) {
      broadcast({ type: 'models_updated', models: result.models, defaultModel: result.defaultModel });
    }
  } else if (reason !== 'manual') {
    console.warn(`[modelos] No se pudo sincronizar [${reason}]: ${result.message}`);
  }
  return result;
}

app.post('/api/models/sync', requireAuth, async (req, res) => {
  const clientKey = req.headers['x-claude-api-key'] || req.body?.apiKey || null;
  const result = await runModelsSync(clientKey, 'manual');
  res.json(result);
});

// Gasto acumulado por modelo (el admin ve el total; cada usuario, el suyo y su límite mensual)
app.get('/api/usage', requireAuth, (req, res) => {
  const own = isRestricted(req.user);
  res.json({
    success: true,
    usage: getUsage(own ? req.user.username : null),
    monthlyLimit: own ? monthlyLimitStatus(req.user, false) : null,
    pricing: getPricingInfo()
  });
});

// Porcentaje gastado de los límites de la suscripción del anfitrión (sesión y semana)
app.get('/api/usage/plan', requireAuth, async (req, res) => {
  const clientKey = req.headers['x-claude-api-key'] || null;
  if (getAppMode() === 'Client' || clientKey) {
    return res.json({ success: false, notApplicable: true, message: 'Estás usando una clave de API: no hay límites de suscripción.' });
  }
  res.json(await getPlanLimits(getHostOAuthToken(), req.query.refresh === '1' ? { maxAgeMs: 0 } : {}));
});

// Tras cada respuesta que gasta la suscripción, avisar a todos los dispositivos del nuevo porcentaje
async function broadcastPlanLimits() {
  if (getAppMode() === 'Client') return;
  const limits = await getPlanLimits(getHostOAuthToken(), { maxAgeMs: 20 * 1000 });
  if (limits.success) broadcast({ type: 'plan_limits', limits });
}

app.post('/api/usage/reset', requireAuth, requireAdmin, (req, res) => {
  res.json({ success: true, usage: resetUsage() });
});

app.post('/api/auth/validate-key', requireAuth, (req, res) => {
  const { apiKey } = req.body || {};
  const result = validateApiKey(apiKey);
  res.json(result);
});

app.get('/api/sessions', requireAuth, (req, res) => {
  res.json({ success: true, sessions: getAllSessions(req.user.username) });
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { title } = req.body || {};
  const session = createSession(title, getCurrentWorkspace(req.user), { owner: req.user.username });
  notifySessionsChanged(req.user.username);
  res.json({ success: true, session });
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  const session = getSession(req.params.id, req.user.username);
  if (session) {
    res.json({ success: true, session, liveTask: liveTaskFor(req.user.username, session.id) });
  } else {
    res.status(404).json({ success: false, error: 'Conversación no encontrada' });
  }
});

// --------------------------------------------------------------------------
// Notificaciones push (app instalada)
// --------------------------------------------------------------------------
app.get('/api/push/key', requireAuth, (req, res) => {
  res.json({ success: true, publicKey: getPushPublicKey() });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  try {
    addSubscription(req.user.username, req.body?.subscription);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  removeSubscription(req.user.username, String(req.body?.endpoint || ''));
  res.json({ success: true });
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  if (!getSession(req.params.id, req.user.username)) {
    return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
  }
  const removed = deleteSession(req.params.id);
  forgetChat(req.params.id);
  // En incógnito se borra también la transcripción que guarda Claude Code en disco
  if (removed && removed.incognito && removed.claudeSessionId) {
    deleteClaudeTranscript(removed.claudeSessionId);
  }
  notifySessionsChanged(req.user.username);
  res.json({ success: !!removed });
});

app.get('/api/workspace', requireAuth, (req, res) => {
  const target = req.query.dir || getCurrentWorkspace(req.user);
  try {
    const list = listDirectory(req.user, target);
    res.json({ success: true, ...list });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Imágenes de la carpeta de trabajo para mostrarlas dentro del chat (solo lectura, solo imágenes)
const CHAT_IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
const CHAT_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
// Para que el chat muestre la imagen en vez de solo nombrar el archivo
const CHAT_IMAGE_HINT = 'Cuando crees o generes una imagen (png, jpg, gif, webp o svg), guárdala en la carpeta de trabajo y muéstrala en tu respuesta con la sintaxis Markdown ![descripción](ruta/de/la/imagen.png), usando la ruta del archivo (sin espacios en el nombre). Así el usuario la ve directamente en el chat sin tener que abrir archivos.';

app.get('/api/files/image', requireAuth, (req, res) => {
  const requested = String(req.query.path || '');
  const type = CHAT_IMAGE_TYPES[path.extname(requested).toLowerCase()];
  if (!requested || !type) return res.status(400).json({ success: false, error: 'Solo se pueden mostrar imágenes.' });
  try {
    const base = String(req.query.workspace || getCurrentWorkspace(req.user));
    const resolved = fs.realpathSync(path.resolve(base, requested));
    if (!isPathAllowed(req.user, base) || !isPathAllowed(req.user, resolved)) {
      return res.status(403).json({ success: false, error: 'No tienes acceso a esa imagen.' });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(404).json({ success: false, error: 'Imagen no encontrada.' });
    if (stat.size > CHAT_IMAGE_MAX_BYTES) return res.status(413).json({ success: false, error: 'La imagen es demasiado grande.' });
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
    return fs.createReadStream(resolved).pipe(res);
  } catch {
    return res.status(404).json({ success: false, error: 'Imagen no encontrada.' });
  }
});

// Cambios sin guardar de una carpeta (panel de cambios de la app de escritorio)
function gitTarget(req, res) {
  const dir = String(req.query.workspace || getCurrentWorkspace(req.user));
  if (!isPathAllowed(req.user, dir)) {
    res.status(403).json({ success: false, error: 'No tienes acceso a esa carpeta.' });
    return null;
  }
  return dir;
}

app.get('/api/git/changes', requireAuth, async (req, res) => {
  const dir = gitTarget(req, res);
  if (dir) res.json({ success: true, ...(await getGitChanges(dir)) });
});

app.get('/api/git/summary', requireAuth, async (req, res) => {
  const dir = gitTarget(req, res);
  if (dir) res.json({ success: true, ...(await getGitSummary(dir)) });
});

app.post('/api/workspace', requireAuth, (req, res) => {
  const { path: newPath } = req.body || {};
  try {
    const updated = setWorkspace(req.user, newPath);
    sendToUser(req.user.username, { type: 'workspace_changed', workspace: updated });
    res.json({ success: true, workspace: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/workspace/create', requireAuth, (req, res) => {
  const { parentPath, name } = req.body || {};
  try {
    const created = createDirectory(req.user, parentPath || getCurrentWorkspace(req.user), name);
    res.json({ success: true, created });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/quick-locations', requireAuth, (req, res) => {
  res.json({ success: true, locations: getQuickLocations(req.user) });
});

app.post('/api/cancel', requireAuth, (req, res) => {
  const result = cancelOwnerTask(req.user.username);
  sendToUser(req.user.username, { type: 'task_canceled', result });
  res.json({ success: true, ...result });
});

// --------------------------------------------------------------------------
// Orquestador: ajustes por usuario (iguales en todos sus dispositivos)
// --------------------------------------------------------------------------
function orchestrationView(user) {
  const config = getOrchestrationConfig(user.username);
  const models = catalog(getAvailableModels());
  const providers = getProvidersStatus();
  return {
    config,
    recommended: recommendRoles(models, providers),
    reviewer: resolveReviewer(config, models, providers, providerOf),
    providers
  };
}

app.get('/api/orchestration', requireAuth, (req, res) => {
  res.json({ success: true, ...orchestrationView(req.user) });
});

app.put('/api/orchestration', requireAuth, (req, res) => {
  setOrchestrationConfig(req.user.username, req.body || {});
  const view = orchestrationView(req.user);
  sendToUser(req.user.username, { type: 'orchestration_updated', ...view });
  res.json({ success: true, ...view });
});

// Cancelar la tarea del usuario: el desarrollador, el revisor y lo que quedara por hacer
function cancelOwnerTask(owner) {
  liveTasks.get(owner)?.controller?.cancel();
  const result = cancelActiveTask(owner);
  liveTasks.delete(owner);
  return result;
}

const notifySessionsChanged = (owner) => sendToUser(owner, { type: 'sessions_changed' });

// --------------------------------------------------------------------------
// Un turno de trabajo: el modelo elegido desarrolla y, si el orquestador está activo,
// otro modelo lo va revisando (durante la tarea y al terminar). Con «corregir solo», lo que
// señale el revisor vuelve al desarrollador como un turno nuevo, hasta `maxRounds` rondas.
// --------------------------------------------------------------------------
function startTurn(user, params) {
  const owner = user.username;
  const { prompt, workspace, sessionId, permissionMode, model, apiKey, attachments, effort, outputStyle, customInstructions, incognito } = params;
  const origin = params.origin || 'user';
  const round = params.round || 0;
  const targetWs = workspace || getCurrentWorkspace(user);
  const attachmentList = Array.isArray(attachments) ? attachments : [];
  const mode = permissionMode || 'acceptEdits';
  const usingOwnKey = getAppMode() === 'Client' || !!(apiKey && String(apiKey).trim());

  // Comprobaciones antes de crear nada: carpeta, modo y límite mensual
  const rejection = liveTasks.has(owner)
    ? 'Ya tienes una tarea en ejecución. Cancélala primero.'
    : !isPathAllowed(user, targetWs)
      ? 'No tienes acceso a esa carpeta. Elige una de tus carpetas permitidas.'
      : isRestricted(user) && !isModeAllowed(user, mode)
        ? 'Tu usuario no tiene permitido ese modo de ejecución.'
        : monthlyLimitStatus(user, usingOwnKey)?.reached
          ? `Has alcanzado tu límite mensual de ${user.monthlyLimitUSD.toFixed(2)} USD. Pídele al administrador que lo amplíe o usa tu propia clave de API.`
          : null;
  if (rejection) {
    sendToUser(owner, {
      type: 'task_error',
      sessionId: sessionId || null,
      message: { role: 'assistant', status: 'error', error: rejection },
      error: { message: rejection }
    });
    return;
  }

  const modelId = model || getDefaultModelId();
  const provider = providerOf(modelId);
  const providerName = PROVIDERS[provider].name;

  // La herramienta del proveedor es opcional (se instala desde Ajustes): avisar en vez de fallar al lanzarla
  const neededTool = provider === 'gemini' && getProvidersStatus().gemini?.backend === 'agy' ? null : provider;
  if (neededTool && TOOL_IDS.includes(neededTool) && !toolAvailable(neededTool)) {
    const message = `${toolLabel(neededTool)} no está instalado en el servidor. Instálalo desde Ajustes → Cuentas del servidor para usar ${providerName}.`;
    sendToUser(owner, { type: 'task_error', sessionId: sessionId || null, message: { role: 'assistant', status: 'error', error: message }, error: { message } });
    return;
  }

  // Get or create session
  let currentSession = sessionId ? getSession(sessionId, owner) : null;
  if (!currentSession) {
    currentSession = createSession('Nueva conversación', targetWs, { incognito: !!incognito, owner });
  }

  const autofix = origin === 'autofix';
  const userMsg = {
    id: Date.now().toString(),
    role: 'user',
    // En «corregir solo» el chat muestra una línea corta; el desarrollador recibe el informe completo
    text: autofix ? `Corrigiendo lo que señaló el revisor (ronda ${round} de ${params.maxRounds})` : prompt,
    ...(autofix ? { kind: 'autofix', round } : {}),
    // Solo los nombres: el contenido de los adjuntos nunca se guarda
    attachments: attachmentList.map(a => String(a.name || 'archivo')),
    workspace: targetWs,
    timestamp: Date.now()
  };

  // Lo que este proveedor aún no ha visto del chat (otro modelo respondió entre medias): va como contexto
  const resumeId = getProviderSessionId(currentSession, provider);
  const taskPrompt = withChatContext(prompt, currentSession.messages, provider, !!resumeId);

  addMessageToSession(currentSession.id, userMsg);
  sendToUser(owner, { type: 'user_message', sessionId: currentSession.id, message: userMsg });
  notifySessionsChanged(owner);

  const assistantMsg = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    text: '',
    thinking: '',
    tools: [],
    workspace: targetWs,
    model: modelId,
    provider,
    timestamp: Date.now(),
    status: 'running'
  };

  // Revisor del orquestador (null si está desactivado o no hay con qué revisar)
  const orch = getOrchestrationConfig(owner);
  const reviewer = orch.enabled ? resolveReviewer(orch, catalog(getAvailableModels()), getProvidersStatus(), providerOf) : null;
  const reviews = [];
  if (reviewer) assistantMsg.reviews = reviews;

  const live = { sessionId: currentSession.id, seq: 0, message: assistantMsg, provider, controller: null };
  sendToUser(owner, { type: 'assistant_start', sessionId: currentSession.id, message: assistantMsg });
  liveTasks.set(owner, live);
  const endLiveTask = () => {
    if (liveTasks.get(owner)?.message === assistantMsg) liveTasks.delete(owner);
  };

  // Puente de permisos de esta tarea: las rutas fuera de las carpetas del usuario se deniegan sin preguntar.
  // El desarrollador puede además crear un proyecto y mover la conversación a él (como en T3 Code).
  // Tras mover la conversación a un proyecto, la carpeta nueva queda fuera del directorio de trabajo de esta
  // tarea: con «Aceptar ediciones» o «Autónomo», editar dentro de ella no pide permiso archivo a archivo.
  let movedTo = null;
  const permissionSecret = registerTask({
    owner,
    chatId: currentSession.id,
    check: (tool, input) => toolPathViolation(user, tool, input, targetWs),
    auto: (tool, input) => movedTo && ['acceptEdits', 'auto'].includes(mode) && isProjectEdit(tool, input, movedTo) ? { behavior: 'allow' } : null,
    actions: currentSession.incognito ? null : {
      create_project: (args) => {
        const project = createProject(user, args);
        movedTo = project.dir;
        moveSession(currentSession.id, project.dir);
        try {
          setWorkspace(user, project.dir);
          sendToUser(owner, { type: 'workspace_changed', workspace: project.dir });
        } catch {
          // la carpeta activa no cambia, pero la conversación sí se ha movido
        }
        sendToUser(owner, { type: 'session_moved', sessionId: currentSession.id, workspace: project.dir, name: project.name, created: project.created });
        notifySessionsChanged(owner);
        return project;
      }
    }
  });
  // Solo Claude habla con el servidor MCP de Zer0Code (los demás proveedores no lo cargan)
  const canCreateProjects = provider === 'claude' && !currentSession.incognito;

  const controller = reviewer
    ? createReviewController({
        owner,
        chatId: currentSession.id,
        workspace: targetWs,
        userPrompt: prompt,
        developerName: modelId,
        reviewer,
        live: orch.live,
        reviews,
        getResumeId: (p) => getReviewerSessionId(getSession(currentSession.id), p),
        setResumeId: (p, id) => setReviewerSessionId(currentSession.id, p, id),
        onUpdate: (review) => sendToUser(owner, {
          type: 'review_update',
          sessionId: currentSession.id,
          messageId: assistantMsg.id,
          review
        }),
        // El revisor solo lee: Claude con una política que aprueba lecturas y deniega el resto; los demás, en solo lectura
        run: (opts) => {
          const reviewerClaude = reviewer.provider === 'claude';
          const secret = reviewerClaude
            ? registerTask({
                owner,
                chatId: currentSession.id,
                check: (tool, input) => toolPathViolation(user, tool, input, targetWs),
                auto: reviewerPermissionPolicy
              })
            : null;
          const release = () => { if (secret) unregisterTask(secret); };
          try {
            return executeWithProvider(reviewer.provider, {
              ...opts,
              workspace: targetWs,
              owner: reviewKey(owner, currentSession.id),
              restricted: true,
              permissionMode: reviewerClaude ? 'manual' : 'plan',
              permissionBridge: secret ? { url: permissionCallbackUrl(), secret } : undefined,
              apiKey: apiKey || null,
              onDone: (result) => {
                release();
                if (reviewerClaude) {
                  const cost = summarizeResultCost(result.result);
                  if (cost) recordUsage(cost, owner, { hostAccount: !usingOwnKey });
                } else {
                  recordUsage(summarizeProviderUsage(reviewer.provider, reviewer.model, result), owner, { hostAccount: false });
                }
                opts.onDone(result);
              },
              onError: (err) => {
                release();
                opts.onError(err);
              }
            });
          } catch (err) {
            release();
            throw err;
          }
        }
      })
    : null;
  live.controller = controller;

  const fail = (message) => {
    unregisterTask(permissionSecret);
    controller?.cancel();
    endLiveTask();
    assistantMsg.status = 'error';
    assistantMsg.error = message;
  };

  // Cierre de la tarea del desarrollador: espera a la revisión final, guarda el mensaje y, si toca, encadena la corrección
  const finishTurn = async (result) => {
    unregisterTask(permissionSecret);
    // El desarrollador ha terminado: esperar a la revisión final antes de dar la tarea por cerrada
    let lastReview = null;
    if (controller) {
      sendToUser(owner, { type: 'task_phase', sessionId: currentSession.id, phase: 'reviewing' });
      try {
        lastReview = await controller.finish();
      } catch (err) {
        console.error('Error en la revisión:', err.message);
      }
    }
    const stillLive = liveTasks.get(owner)?.message === assistantMsg;
    endLiveTask();

    assistantMsg.status = 'completed';
    if (!assistantMsg.text && result.text) {
      assistantMsg.text = result.text;
    }
    // El resultado final solo contiene el último bloque de texto: usarlo solo si no se recibió nada en streaming
    if (!assistantMsg.text && result.result && result.result.result) {
      assistantMsg.text = typeof result.result.result === 'string'
        ? result.result.result
        : JSON.stringify(result.result.result, null, 2);
    }
    assistantMsg.duration = result.result?.duration_ms || null;

    // Coste de la respuesta según Claude Code (precio de tarifa de la API); ChatGPT y Gemini van por suscripción
    const cost = provider === 'claude' ? summarizeResultCost(result.result) : null;
    if (cost) {
      assistantMsg.cost = cost;
      recordUsage(cost, owner, { hostAccount: !usingOwnKey });
    }

    if (provider !== 'claude') {
      recordUsage(summarizeProviderUsage(provider, modelId, result), owner, { hostAccount: false });
    }

    if (result.sessionId) {
      setProviderSessionId(currentSession.id, provider, result.sessionId);
    }

    addMessageToSession(currentSession.id, assistantMsg);

    const flagged = lastReview?.verdict === 'CAMBIOS';
    pushIfAway(owner, {
      // En incógnito no se muestra nada de la conversación en la pantalla de bloqueo
      title: currentSession.incognito ? `${providerName} ha terminado` : currentSession.title || `${providerName} ha terminado`,
      body: currentSession.incognito
        ? 'Chat incógnito'
        : `${flagged ? 'El revisor propone cambios. ' : ''}${notificationBody(assistantMsg.text, `${providerName} ha terminado la tarea`)}`,
      tag: `task-${currentSession.id}`,
      sessionId: currentSession.id
    });

    sendToUser(owner, {
      type: 'task_completed',
      sessionId: currentSession.id,
      message: assistantMsg,
      result
    });
    notifySessionsChanged(owner);

    if (!apiKey && provider === 'claude') broadcastPlanLimits();

    // Corregir solo: el informe del revisor vuelve al desarrollador, con un tope de rondas
    if (stillLive && orch.autoFix && lastReview?.status === 'done' && flagged && round < orch.maxRounds) {
      startTurn(user, {
        ...params,
        prompt: autoFixPrompt(lastReview),
        sessionId: currentSession.id,
        attachments: [],
        // Si el desarrollador movió la conversación a un proyecto nuevo, la corrección sigue allí
        workspace: getSession(currentSession.id)?.workspace || targetWs,
        origin: 'autofix',
        round: round + 1,
        maxRounds: orch.maxRounds
      });
    }
  };

  try {
    executeWithProvider(provider, {
      prompt: taskPrompt,
      workspace: targetWs,
      sessionId: resumeId,
      owner,
      restricted: isRestricted(user),
      permissionMode: mode,
      permissionBridge: { url: permissionCallbackUrl(), secret: permissionSecret, ...(canCreateProjects ? { actionUrl: permissionCallbackUrl('action') } : {}) },
      model: model || null,
      apiKey: apiKey || null,
      attachments: attachmentList,
      effort: effort || null,
      outputStyle: outputStyle || null,
      customInstructions: [CHAT_IMAGE_HINT, canCreateProjects ? projectToolHint(targetWs) : '', getProfilePrompt(owner), typeof customInstructions === 'string' ? customInstructions : '']
        .filter(Boolean).join('\n\n') || null,
      onEvent: (event) => {
        // Id de la sesión del proveedor, por si el servidor se apaga antes de terminar
        if (event.sessionId && liveTasks.get(owner)?.message === assistantMsg) live.providerSessionId = event.sessionId;
        if (event.type === 'text_delta') {
          assistantMsg.text += event.text;
          sendTaskEvent(owner, { type: 'stream_delta', sessionId: currentSession.id, text: event.text });
        } else if (event.type === 'thinking_delta') {
          assistantMsg.thinking += event.thinking;
          sendTaskEvent(owner, { type: 'stream_thinking', sessionId: currentSession.id, thinking: event.thinking });
        } else if (event.type === 'text_raw') {
          assistantMsg.text += event.text + '\n';
          sendTaskEvent(owner, { type: 'stream_raw', sessionId: currentSession.id, text: event.text });
        } else if (event.type === 'tool_use') {
          assistantMsg.tools.push({
            id: event.id,
            tool: event.tool,
            input: event.input,
            subagent: !!event.subagent,
            status: 'running',
            time: Date.now()
          });
          sendTaskEvent(owner, {
            type: 'tool_use',
            sessionId: currentSession.id,
            id: event.id,
            tool: event.tool,
            input: event.input,
            subagent: !!event.subagent
          });
        } else if (event.type === 'tool_result') {
          const toolEntry = assistantMsg.tools.find(t => t.id === event.id);
          if (toolEntry) toolEntry.status = event.isError ? 'error' : 'done';
          // Cada edición terminada con éxito le avisa al revisor
          if (controller && toolEntry && !toolEntry.subagent && !event.isError && EDIT_TOOLS.has(toolEntry.tool)) {
            controller.noteEdit(toolEntry.input?.file_path || toolEntry.input?.notebook_path);
          }
          sendTaskEvent(owner, {
            type: 'tool_result',
            sessionId: currentSession.id,
            id: event.id,
            isError: event.isError,
            content: event.content
          });
        }
      },
      onDone: (result) => {
        finishTurn(result).catch((err) => {
          console.error('Error cerrando la tarea:', err);
          endLiveTask();
          sendToUser(owner, {
            type: 'task_error',
            sessionId: currentSession.id,
            message: { ...assistantMsg, status: 'error', error: err.message },
            error: { message: err.message }
          });
        });
      },
      onError: (err) => {
        fail(err.message || `Error en la ejecución de ${PROVIDERS[provider].cli}`);
        if (err.text) assistantMsg.text = err.text;

        addMessageToSession(currentSession.id, assistantMsg);

        pushIfAway(owner, {
          title: 'La tarea ha fallado',
          body: currentSession.incognito ? 'Chat incógnito' : notificationBody(assistantMsg.error, currentSession.title),
          tag: `task-${currentSession.id}`,
          sessionId: currentSession.id
        });

        sendToUser(owner, {
          type: 'task_error',
          sessionId: currentSession.id,
          message: assistantMsg,
          error: err
        });
        notifySessionsChanged(owner);
      }
    });
  } catch (err) {
    fail(err.message);
    sendToUser(owner, {
      type: 'task_error',
      sessionId: currentSession.id,
      message: assistantMsg,
      error: { message: err.message }
    });
  }
}

// --------------------------------------------------------------------------
// WebSocket Server
// --------------------------------------------------------------------------
wss.on('connection', (ws) => {
  ws.isAuthenticated = false;
  ws.authToken = null;
  ws.username = null;
  ws.visible = true;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Autenticación: el token llega en el primer mensaje, nunca en la URL
      if (data.type === 'auth') {
        const authUser = getUserFromToken(data.token);
        if (authUser && !authUser.mustChangePassword) {
          ws.isAuthenticated = true;
          ws.authToken = data.token;
          ws.username = authUser.username;
          ws.visible = data.visible !== false;
          ws.send(JSON.stringify({
            type: 'auth_success',
            workspace: getCurrentWorkspace(authUser),
            isTaskActive: isTaskActive(authUser.username),
            user: userInfo(authUser),
            // Peticiones de permiso que siguen esperando (p. ej. tras perder la conexión en el móvil)
            pendingPermissions: listPendingFor(authUser.username),
            // Respuesta que sigue generándose aunque se cerrara la web
            liveTask: liveTaskFor(authUser.username)
          }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Token inválido' }));
        }
        return;
      }

      // Bloquear mensajes sin sesión (o cuya sesión se ha cerrado mientras tanto).
      // El usuario se relee en cada mensaje: el admin puede haber cambiado sus permisos.
      const user = ws.isAuthenticated ? getUserFromToken(ws.authToken) : null;
      if (!user || user.mustChangePassword) {
        ws.isAuthenticated = false;
        ws.send(JSON.stringify({ type: 'auth_error', message: 'No autenticado' }));
        return;
      }
      const owner = user.username;

      // La web avisa cuando pasa a segundo plano o vuelve (para decidir si enviar push)
      if (data.type === 'visibility') {
        ws.visible = data.visible === true;
        return;
      }

      if (data.type === 'run_task') {
        startTurn(user, data);
      } else if (data.type === 'permission_response') {
        answerPermission(String(data.id || ''), owner, {
          allow: data.allow === true,
          always: data.always === true,
          message: data.message
        });
      } else if (data.type === 'cancel_task') {
        sendToUser(owner, { type: 'task_canceled', result: cancelOwnerTask(owner) });
      }
    } catch (e) {
      console.error('WebSocket message error:', e.message);
    }
  });
});

// Helper to get local network IPv4 addresses
function getLocalIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    const isVirtual = /vEthernet|WSL|Hyper-V|vboxnet|docker|vmnet/i.test(name);
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        ips.push({
          name,
          address: net.address,
          priority: isVirtual ? 1 : (net.address.startsWith('192.168.') || net.address.startsWith('10.') ? 10 : 5)
        });
      }
    }
  }
  ips.sort((a, b) => b.priority - a.priority);
  return ips;
}

// Mantener el catálogo de modelos al día con la API de Anthropic
const MODELS_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => runModelsSync(null, 'periódica'), MODELS_SYNC_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => {
  runModelsSync(null, 'arranque');

  const ips = getLocalIps();
  const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
  const currentMode = getAppMode();

  let authSummary = 'Consultando...';
  try {
    const auth = getClaudeAuthStatus();
    if (auth && auth.loggedIn) {
      const plan = auth.subscriptionType ? auth.subscriptionType.toUpperCase() : 'PRO';
      authSummary = `✅ Conectada (${auth.email || 'Cuenta activa'} - Plan ${plan})`;
    } else {
      authSummary = `⚠️ NO conectada (Ejecuta: pnpm auth:login o añade ANTHROPIC_API_KEY en .env)`;
    }
  } catch (e) {
    authSummary = `⚠️ No detectada (${e.message})`;
  }

  console.log('====================================================');
  console.log('       🌟 ZER0CODE - INTERFAZ CLAUDE.AI 🌟        ');
  console.log('====================================================');
  console.log(`💻 Acceso PC:           http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`📱 Acceso móvil (Wi-Fi): http://${primaryIp}:${PORT}`);
  } else {
    console.log(`🔒 Solo escucha en:     ${HOST} (HOST en .env)`);
  }
  console.log('----------------------------------------------------');
  console.log(`📡 Modo (.env):         MODE=${currentMode} (${currentMode === 'Hoster' ? 'Cuenta compartida del anfitrión' : 'Cada cliente usa su propia key'})`);
  console.log(`🤖 Cuenta Claude:       ${authSummary}`);
  console.log(`👤 Administrador:       ${getAdminUsername()}`);
  console.log(`🔑 Contraseña:          ${isUsingDefaultPassword() ? '⚠️ Por defecto: se pedirá cambiarla al entrar' : `Guardada cifrada en ${path.join(DATA_DIR, 'auth.json')}`}`);
  console.log('====================================================');

  // Los accesos directos de los instaladores (Windows y macOS) abren la web al arrancar
  if (process.env.ZER0CODE_OPEN_BROWSER === '1') openInBrowser(`http://localhost:${PORT}`);
});

// Al apagar o reiniciar (pm2 restart, Ctrl+C) se guarda lo que llevan las respuestas en curso;
// si no, la respuesta se perdía entera porque solo se guarda al terminar la tarea.
function saveLiveTasksOnShutdown(signal) {
  for (const [owner, live] of liveTasks) {
    const msg = live.message;
    msg.status = 'error';
    msg.error = 'El servidor se reinició antes de que terminara la respuesta.';
    msg.tools.forEach(t => { if (t.status === 'running') t.status = 'error'; });
    live.controller?.cancel();
    try {
      cancelActiveTask(owner);
    } catch {
      // el proceso ya había terminado
    }
    try {
      if (live.providerSessionId) setProviderSessionId(live.sessionId, live.provider, live.providerSessionId);
      addMessageToSession(live.sessionId, msg);
    } catch (err) {
      console.error(`No se pudo guardar la respuesta en curso de ${owner}:`, err.message);
    }
  }
  liveTasks.clear();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.once('SIGINT', () => saveLiveTasksOnShutdown('SIGINT'));
process.once('SIGTERM', () => saveLiveTasksOnShutdown('SIGTERM'));

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch (err) {
    console.warn('No se pudo abrir el navegador:', err.message);
  }
}
