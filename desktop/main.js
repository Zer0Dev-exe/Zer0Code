// Zer0Code para escritorio (Windows, macOS y Linux).
// Una ventana con la misma web de Zer0Code. Tiene dos modos:
//  - «local»: lleva el servidor dentro y corre en este equipo (sus chats viven aquí; con «compartir en la red»
//    el móvil y otros equipos pueden entrar a ellos).
//  - «remoto»: se conecta a tu servidor de Zer0Code (VPS, Tailscale…): los mismos chats que en la web y el móvil.
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, nativeImage, session } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createUpdater } = require('./updater');

const APP_NAME = 'Zer0Code';
const DEFAULT_PORT = 5050;
const SERVER_START_TIMEOUT_MS = 40 * 1000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60 * 1000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

app.setName(APP_NAME); // antes de userData: así la carpeta de datos es la misma en desarrollo y empaquetada
const userData = app.getPath('userData');
const CONFIG_FILE = path.join(userData, 'desktop-config.json');
const DATA_DIR = path.join(userData, 'data');
const ENV_FILE = path.join(userData, '.env');
const LOG_DIR = path.join(userData, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const SHIM_DIR = path.join(userData, 'shim');

// AppImage en Linux: sin chrome-sandbox con permisos de root, Chromium solo puede aislar los procesos con
// espacios de nombres de usuario. Ubuntu 24.04+ los restringe con AppArmor: en ese caso la app ni arrancaría.
// El .deb instala chrome-sandbox con los permisos correctos y no necesita esto.
function userNamespacesBlocked() {
  const read = (file) => { try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return null; } };
  return read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1'
    || read('/proc/sys/kernel/unprivileged_userns_clone') === '0';
}
if (process.platform === 'linux' && process.env.APPIMAGE && userNamespacesBlocked()) {
  app.commandLine.appendSwitch('no-sandbox');
}

app.setAppUserModelId('es.zer0dev.zer0code');

// ---------------------------------------------------------------------------
// Una sola instancia: abrir la app otra vez trae la ventana existente
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => showWindow());

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
let config = { mode: null, remoteUrl: null, shareLan: false, port: null };

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch {
    // primera vez: sin configuración
  }
}

function saveConfig() {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Añade https:// si falta (http:// para IPs y localhost) y quita la barra final; null si no es una dirección válida */
function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!url.includes('://')) {
    const lan = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(url) || /^localhost(:\d+)?(\/.*)?$/.test(url);
    url = `${lan ? 'http' : 'https'}://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Comprueba que la dirección es un servidor de Zer0Code (devuelve null si lo es, o el motivo) */
async function checkServer(origin) {
  try {
    const res = await fetch(`${origin}/manifest.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return `El servidor ha respondido con el código ${res.status}.`;
    const text = (await res.text()).slice(0, 64 * 1024);
    if (!text.includes('"start_url"')) return 'Esa dirección responde, pero no es un servidor de Zer0Code.';
    return null;
  } catch (err) {
    const code = err.cause?.code || err.code || '';
    if (code === 'ENOTFOUND') return 'No se encuentra el servidor. Revisa la dirección y, si usas Tailscale, que esté activo en este equipo.';
    if (code === 'ECONNREFUSED') return 'No hay ningún servidor de Zer0Code en esa dirección. Comprueba que está arrancado y el puerto.';
    if (/CERT|SSL|TLS/i.test(code)) return 'El certificado HTTPS del servidor no es válido.';
    if (err.name === 'TimeoutError') return 'El servidor no responde. Comprueba que llegas a él (misma red o VPN activa).';
    return `No se puede conectar: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Actualizaciones (releases de GitHub)
// ---------------------------------------------------------------------------
const updater = createUpdater({ getConfig: () => config, saveConfig, quit: () => quitApp(), logDir: LOG_DIR });

// ---------------------------------------------------------------------------
// Servidor integrado (modo local)
// ---------------------------------------------------------------------------
let serverProc = null;
let serverOrigin = null;
let quitting = false;
let restarts = [];

function serverEntry() {
  const packaged = path.join(process.resourcesPath, 'app-server', 'server', 'index.js');
  if (app.isPackaged) return packaged;
  return path.join(__dirname, '..', 'server', 'index.js');
}

function freePort(preferred, host) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', () => (port === 0 ? resolve(DEFAULT_PORT) : tryPort(0)));
      srv.once('listening', () => {
        const { port: got } = srv.address();
        srv.close(() => resolve(got));
      });
      srv.listen(port, host);
    };
    tryPort(preferred);
  });
}

/**
 * Algunos CLIs (Codex, Gemini) son scripts de Node con `#!/usr/bin/env node`. Si el equipo no tiene Node,
 * se les da uno que es la propia app de escritorio funcionando como Node. Va al final del PATH: si hay un Node real, gana.
 */
function ensureNodeShim() {
  try {
    fs.mkdirSync(SHIM_DIR, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(SHIM_DIR, 'node.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`);
    } else {
      const file = path.join(SHIM_DIR, 'node');
      fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    return SHIM_DIR;
  } catch (err) {
    console.warn('No se pudo crear el atajo de Node:', err.message);
    return null;
  }
}

/** .env del servidor integrado: se crea una sola vez, con una contraseña aleatoria (la app inicia sesión sola) */
function ensureEnvFile() {
  if (fs.existsSync(ENV_FILE)) return;
  const password = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(ENV_FILE, [
    '# Servidor integrado de Zer0Code (lo gestiona la app de escritorio).',
    '# La contraseña solo vale hasta que la cambies desde Perfil > Seguridad.',
    'MODE=Hoster',
    'ZER0CODE_USER=admin',
    `ZER0CODE_PASSWORD=${password}`,
    ''
  ].join('\n'), { mode: 0o600 });
}

function readEnvValue(key) {
  try {
    const match = fs.readFileSync(ENV_FILE, 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0);
  } catch {
    // aún no existe
  }
  return fs.openSync(LOG_FILE, 'a');
}

async function startServer() {
  ensureEnvFile();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const host = config.shareLan ? '0.0.0.0' : '127.0.0.1';
  const port = await freePort(config.port || DEFAULT_PORT, host);
  if (port !== config.port) {
    config.port = port;
    saveConfig();
  }

  const shim = ensureNodeShim();
  const logFd = openLog();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ZER0CODE_DATA_DIR: DATA_DIR,
    ZER0CODE_ENV_FILE: ENV_FILE,
    PORT: String(port),
    HOST: host,
    PATH: shim ? `${process.env.PATH || ''}${path.delimiter}${shim}` : process.env.PATH
  };

  serverProc = spawn(process.execPath, [serverEntry()], { env, stdio: ['ignore', logFd, logFd], windowsHide: true });
  fs.closeSync(logFd);
  serverOrigin = `http://127.0.0.1:${port}`;

  const proc = serverProc;
  proc.once('exit', (code) => {
    if (serverProc === proc) serverProc = null;
    if (quitting || !config.mode || config.mode !== 'local') return;
    const now = Date.now();
    restarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
    if (restarts.length >= MAX_RESTARTS) {
      dialog.showErrorBox(APP_NAME, `El servidor integrado se ha detenido varias veces seguidas (código ${code}).\n\nRegistro: ${LOG_FILE}`);
      return;
    }
    restarts.push(now);
    startServer().then(waitForServer).then(() => loadApp()).catch(err => console.error('No se pudo reiniciar el servidor:', err.message));
  });

  await waitForServer();
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!serverProc) throw new Error(`El servidor se detuvo al arrancar. Mira el registro: ${LOG_FILE}`);
    try {
      const res = await fetch(`${serverOrigin}/manifest.json`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // todavía arrancando
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`El servidor no arrancó a tiempo. Mira el registro: ${LOG_FILE}`);
}

/** Detiene el servidor y espera a que guarde lo que lleve (recibe SIGTERM y lo guarda antes de salir) */
function stopServer() {
  const proc = serverProc;
  if (!proc) return Promise.resolve();
  serverProc = null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ya terminó */ } resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/** Direcciones por las que otros dispositivos de la red llegan al servidor integrado */
function lanUrls() {
  if (config.mode !== 'local' || !config.shareLan || !config.port) return [];
  const urls = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254')) urls.push(`http://${n.address}:${config.port}`);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------
let win = null;
let tray = null;

const THEME_COLORS = {
  dark: { color: '#0b1010', symbolColor: '#a3a3a3', background: '#0a0a0a' },
  light: { color: '#f3f9f9', symbolColor: '#52525b', background: '#fcfcfc' }
};
const TITLEBAR_HEIGHT = 52;

function createWindow() {
  const isMac = process.platform === 'darwin';
  const theme = THEME_COLORS.dark;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: theme.background,
    // Ventana sin marco como T3 Code: la web pinta su propia barra superior.
    // macOS: semáforos nativos; Windows: controles nativos superpuestos; Linux: sin marco y los botones los pinta la web.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : process.platform === 'linux'
        ? { frame: false }
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: theme.color, symbolColor: theme.symbolColor, height: TITLEBAR_HEIGHT } }),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  win.once('ready-to-show', () => win.show());
  if (!isMac) win.setMenuBarVisibility(false);

  // Enlaces externos al navegador del sistema; la ventana solo navega por el servidor y la pantalla de conexión
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file://') || (currentOrigin() && url.startsWith(currentOrigin()));
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // Con el servidor integrado, cerrar la ventana la oculta: las tareas siguen y los avisos llegan igualmente
  win.on('close', (event) => {
    if (quitting || config.mode !== 'local') return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
}

function currentOrigin() {
  if (config.mode === 'local') return serverOrigin;
  if (config.mode === 'remote') return config.remoteUrl;
  return null;
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showConnectScreen() {
  showWindow();
  return win.loadFile(path.join(__dirname, 'connect.html'));
}

/** Pone la sesión del servidor integrado sin pedir contraseña: la app conoce la suya */
async function autoLoginLocal() {
  const origin = serverOrigin;
  await win.loadURL(`${origin}/favicon.svg`);
  const valid = await win.webContents.executeJavaScript(`(async () => {
    const token = localStorage.getItem('zer0code_token');
    if (!token) return false;
    const res = await fetch('/api/auth/verify', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
    return !!(res && res.ok);
  })()`);
  if (valid) return;
  const password = readEnvValue('ZER0CODE_PASSWORD');
  if (!password) return;
  try {
    const res = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: readEnvValue('ZER0CODE_USER') || 'admin', password })
    });
    const data = await res.json();
    if (data.success && data.token) {
      await win.webContents.executeJavaScript(
        `localStorage.setItem('zer0code_token', ${JSON.stringify(data.token)}); localStorage.setItem('zer0code_user', ${JSON.stringify(data.username || 'admin')});`
      );
    }
  } catch {
    // sin sesión automática: la web pedirá la contraseña
  }
}

// La interfaz de escritorio la sirve el propio servidor en /desktop/ (así habla con él sin permisos cruzados)
async function checkDesktopUi(origin) {
  try {
    const res = await fetch(`${origin}/desktop/index.html`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadApp() {
  showWindow();
  if (config.mode === 'local') {
    await autoLoginLocal();
    await win.loadURL(`${serverOrigin}/desktop/`);
  } else if (config.mode === 'remote') {
    if (!(await checkDesktopUi(config.remoteUrl))) {
      throw new Error('Este servidor es de una versión anterior y no incluye la interfaz de escritorio. Actualiza tu servidor de Zer0Code y vuelve a conectar.');
    }
    await win.loadURL(`${config.remoteUrl}/desktop/`);
  }
  buildMenu();
  updateTray();
}

async function launch() {
  if (!config.mode) return showConnectScreen();
  try {
    if (config.mode === 'local') {
      showWindow();
      await win.loadFile(path.join(__dirname, 'connect.html'), { query: { starting: '1' } });
      await startServer();
    } else {
      const problem = await checkServer(config.remoteUrl);
      if (problem) {
        await showConnectScreen();
        win.webContents.once('did-finish-load', () => win.webContents.send('desktop:notice', problem));
        return;
      }
    }
    await loadApp();
  } catch (err) {
    dialog.showErrorBox(APP_NAME, err.message);
    await showConnectScreen();
  }
}

// ---------------------------------------------------------------------------
// IPC (solo desde la pantalla de conexión, salvo cambiar de servidor y enfocar)
// ---------------------------------------------------------------------------
const fromConnectScreen = (event) => String(event.senderFrame?.url || '').startsWith('file://');

ipcMain.handle('desktop:get-state', (event) => {
  if (!fromConnectScreen(event)) return null;
  return { mode: config.mode, remoteUrl: config.remoteUrl, shareLan: config.shareLan, platform: process.platform, version: app.getVersion() };
});

ipcMain.handle('desktop:test-server', async (event, raw) => {
  if (!fromConnectScreen(event)) return { ok: false, error: 'No permitido' };
  const origin = normalizeUrl(raw);
  if (!origin) return { ok: false, error: 'Escribe una dirección válida, por ejemplo https://mi-servidor.tailnet.ts.net' };
  const problem = await checkServer(origin);
  return problem ? { ok: false, error: problem } : { ok: true, url: origin };
});

ipcMain.handle('desktop:connect', async (event, options = {}) => {
  if (!fromConnectScreen(event)) return { ok: false, error: 'No permitido' };
  try {
    if (options.mode === 'remote') {
      const origin = normalizeUrl(options.url);
      if (!origin) return { ok: false, error: 'Escribe una dirección válida.' };
      const problem = await checkServer(origin);
      if (problem) return { ok: false, error: problem };
      await stopServer();
      config = { ...config, mode: 'remote', remoteUrl: origin };
    } else if (options.mode === 'local') {
      await stopServer();
      config = { ...config, mode: 'local', shareLan: options.shareLan === true };
      saveConfig();
      restarts = [];
      await startServer();
    } else {
      return { ok: false, error: 'Opción no válida.' };
    }
    saveConfig();
    await loadApp();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:set-theme', (event, theme) => {
  const t = THEME_COLORS[theme] || THEME_COLORS.dark;
  if (win && process.platform === 'win32') {
    try { win.setTitleBarOverlay({ color: t.color, symbolColor: t.symbolColor, height: TITLEBAR_HEIGHT }); } catch { /* sin controles superpuestos */ }
  }
  win?.setBackgroundColor(t.background);
  return true;
});

const ACCOUNTS = { claude: ['Claude', 'claude', ['auth', 'login']], codex: ['ChatGPT', 'codex', ['login']], gemini: ['Gemini', 'gemini', ['login']] };
ipcMain.handle('desktop:link-account', (event, provider) => {
  if (config.mode !== 'local' || !ACCOUNTS[provider]) return false;
  linkAccount(...ACCOUNTS[provider]);
  return true;
});

ipcMain.handle('desktop:window', (event, action) => {
  if (!win) return false;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === 'close') win.close();
  return true;
});

ipcMain.handle('desktop:get-update', () => updater.state());
ipcMain.handle('desktop:check-update', () => updater.check({ manual: true }));
ipcMain.handle('desktop:install-update', () => updater.install());
ipcMain.handle('desktop:skip-update', (event, version) => { updater.skip(String(version || '')); return true; });
ipcMain.handle('desktop:releases', () => updater.releases());
ipcMain.handle('desktop:dismiss-update-notice', () => { updater.dismissNotice(); return true; });

ipcMain.handle('desktop:change-server', () => showConnectScreen().then(() => true));
ipcMain.handle('desktop:focus', () => { showWindow(); return true; });

// ---------------------------------------------------------------------------
// Cuentas: Claude, ChatGPT (Codex) y Gemini se vinculan desde sus propios CLIs
// ---------------------------------------------------------------------------
function cliBinary(name) {
  // Instalada desde Ajustes (el servidor apunta en su manifiesto dónde está el ejecutable)
  try {
    const dir = path.join(DATA_DIR, 'tools', name);
    const { entry } = JSON.parse(fs.readFileSync(path.join(dir, 'zer0code-tool.json'), 'utf-8'));
    if (entry && fs.existsSync(path.join(dir, entry))) return path.join(dir, entry);
  } catch {
    // no está instalada desde la app
  }
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app-server') : path.join(__dirname, '..');
  const file = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return fs.existsSync(file) ? file : name;
}

function linkAccount(label, bin, args) {
  const shim = ensureNodeShim();
  const env = { ...process.env, PATH: shim ? `${process.env.PATH || ''}${path.delimiter}${shim}` : process.env.PATH };
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn('cmd.exe', ['/c', cliBinary(bin), ...args], { env, windowsHide: true })
    : spawn(cliBinary(bin), args, { env, detached: false });
  let output = '';
  const collect = (d) => { output += d.toString(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const clean = () => output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n').slice(-12).join('\n');

  // La mayoría abren el navegador solos; los que usan código de dispositivo lo imprimen: se enseña a los pocos segundos
  const hint = setTimeout(() => {
    dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: `Vincular ${label}`,
      message: `Sigue los pasos en el navegador para vincular ${label}.`,
      detail: clean() || 'Se ha abierto el navegador. Cuando termines, esta ventana se actualizará sola.'
    });
  }, 4000);

  child.once('error', (err) => {
    clearTimeout(hint);
    dialog.showErrorBox(`Vincular ${label}`, `No se pudo ejecutar el comando: ${err.message}`);
  });
  child.once('exit', (code) => {
    clearTimeout(hint);
    if (code === 0) {
      dialog.showMessageBox(win || undefined, { type: 'info', title: `Vincular ${label}`, message: `${label} vinculado.` });
      if (win && currentOrigin()) win.webContents.reload();
    } else {
      dialog.showErrorBox(`Vincular ${label}`, clean() || `El comando terminó con código ${code}.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Menú y bandeja
// ---------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const local = config.mode === 'local';
  const urls = lanUrls();
  const appMenu = [
    { label: 'Buscar actualizaciones…', click: () => updater.check({ manual: true }).then((st) => {
      if (st.status === 'uptodate') dialog.showMessageBox(win || undefined, { type: 'info', title: APP_NAME, message: `Zer0Code ${st.current} está al día.` });
      else if (st.status === 'error') dialog.showErrorBox(APP_NAME, st.error || 'No se pudo comprobar');
    }) },
    { label: 'Cambiar de servidor…', click: () => showConnectScreen() },
    ...(local ? [
      { type: 'separator' },
      { label: 'Vincular cuentas', submenu: [
        { label: 'Claude…', click: () => linkAccount('Claude', 'claude', ['auth', 'login']) },
        { label: 'ChatGPT (Codex)…', click: () => linkAccount('ChatGPT', 'codex', ['login']) },
        { label: 'Gemini…', click: () => linkAccount('Gemini', 'gemini', ['login']) }
      ] },
      { label: 'Dirección para el móvil…', enabled: urls.length > 0, click: () => dialog.showMessageBox(win || undefined, {
        type: 'info',
        title: 'Dirección para el móvil',
        message: 'Abre una de estas direcciones desde tu móvil o desde la app (en la misma red):',
        detail: urls.join('\n') + '\n\nEntra con el usuario «admin». La contraseña la fijas tú en Perfil → Seguridad.'
      }) },
      { label: 'Ver registro del servidor', click: () => shell.showItemInFolder(LOG_FILE) },
      { label: 'Abrir carpeta de datos', click: () => shell.openPath(userData) }
    ] : []),
    { type: 'separator' },
    { label: 'Salir', accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q', click: () => quitApp() }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, ...appMenu] }] : [{ label: APP_NAME, submenu: appMenu }]),
    { role: 'editMenu' },
    { label: 'Ver', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' }
    ] },
    { role: 'windowMenu' }
  ]));
}

function updateTray() {
  if (config.mode !== 'local') {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (!tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 22, height: 22 }));
      tray.setToolTip(`${APP_NAME}: el servidor sigue en marcha`);
      tray.on('click', () => showWindow());
    } catch (err) {
      console.warn('Sin bandeja del sistema:', err.message);
      return;
    }
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir ${APP_NAME}`, click: () => showWindow() },
    { type: 'separator' },
    { label: 'Salir (detiene el servidor)', click: () => quitApp() }
  ]));
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  await stopServer();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  loadConfig();
  buildMenu();

  // Notificaciones del sistema para la web (avisan cuando una tarea termina o pide permiso)
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'notifications' || permission === 'clipboard-sanitized-write');
  });

  createWindow();
  launch();
  updater.start();

  app.on('activate', () => {
    if (!win) {
      createWindow();
      launch();
    } else {
      showWindow();
    }
  });
});

// Con el servidor integrado la app sigue viva en la bandeja; en modo remoto, al cerrar la ventana se sale
app.on('window-all-closed', () => {
  if (config.mode !== 'local' && process.platform !== 'darwin') quitApp();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitApp();
});
