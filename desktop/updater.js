// Actualizaciones de la app de escritorio. Mira el último release de GitHub, compara versiones y, si hay una
// nueva, ofrece instalarla desde la propia app:
//  - Windows (instalador) y Linux (AppImage): descarga, verifica y se reemplaza sola, y la app se reinicia.
//  - Linux (.deb) y macOS: descarga y abre el instalador del sistema (no se pueden reemplazar en caliente).
// Cada descarga se verifica contra el SHA256SUMS.txt del release antes de ejecutarla.
// Al arrancar se comprueba si la última actualización llegó a aplicarse: si no, se avisa en vez de volver a
// ofrecer la misma versión una y otra vez sin explicación.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { compareVersions, pickAsset, summarizeReleases } = require('./updateLogic');

const REPO = 'Zer0Dev-exe/Zer0Code';
const API_BASE = process.env.ZER0CODE_UPDATE_API_BASE || `https://api.github.com/repos/${REPO}`;
const API = process.env.ZER0CODE_UPDATE_API || `${API_BASE}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const RELEASES_TTL_MS = 10 * 60 * 1000;
const HEADERS = { 'User-Agent': 'Zer0Code-Desktop', Accept: 'application/vnd.github+json' };

const hasDpkg = () => process.platform === 'linux' && ['/usr/bin/dpkg', '/bin/dpkg'].some(f => fs.existsSync(f));
const canInstallInPlace = () => process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);

function createUpdater({ getConfig, saveConfig, quit, logDir }) {
  const state = {
    status: 'idle', current: app.getVersion(), latest: null, progress: 0, error: null, checkedAt: null,
    // Tras reiniciar: { version } si la actualización se aplicó (para enseñar las novedades) o { version, failed: true }
    justUpdated: null
  };
  let timer = null;
  let busy = false;
  let releasesCache = null;

  const log = (...parts) => {
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'updater.log'), `${new Date().toISOString()} ${parts.join(' ')}\n`);
    } catch {
      // sin registro: no es imprescindible
    }
  };

  const publish = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('desktop:update', { ...state });
    }
  };
  const set = (patch) => { Object.assign(state, patch); publish(); };

  /** ¿Se aplicó la actualización que se instaló antes de reiniciar? */
  function verifyPendingUpdate() {
    const cfg = getConfig();
    const pending = cfg.pendingUpdate;
    if (!pending?.version) return;
    delete cfg.pendingUpdate;
    saveConfig();
    if (compareVersions(state.current, pending.version) >= 0) {
      log('aplicada', pending.version);
      state.justUpdated = { version: state.current };
    } else {
      log('NO aplicada', pending.version, 'sigue', state.current, pending.target ? `(${pending.target})` : '');
      state.justUpdated = { version: pending.version, failed: true };
    }
  }

  async function check({ manual = false } = {}) {
    if (busy || state.status === 'downloading') return state;
    busy = true;
    if (manual) set({ status: 'checking', error: null });
    try {
      const res = await fetch(API, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) { set({ status: 'uptodate', latest: null, checkedAt: Date.now() }); return state; }
      if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      if (compareVersions(version, state.current) <= 0) {
        set({ status: 'uptodate', latest: null, error: null, checkedAt: Date.now() });
        return state;
      }
      const asset = pickAsset(rel.assets || [], { dpkg: hasDpkg() });
      const sums = (rel.assets || []).find(a => a.name === 'SHA256SUMS.txt');
      // CI sube los instaladores unos minutos después de publicar el release: hasta que esté la suma de
      // comprobación no se ofrece la actualización
      if (!sums) {
        set({ status: manual ? 'uptodate' : state.status === 'checking' ? 'idle' : state.status, latest: null, checkedAt: Date.now() });
        return state;
      }
      const skipped = getConfig().skippedUpdate === version;
      set({
        status: skipped && !manual ? 'uptodate' : 'available',
        latest: {
          version,
          name: rel.name || `v${version}`,
          notes: String(rel.body || '').slice(0, 4000),
          page: rel.html_url,
          // Sin instalador para este sistema (por ejemplo Linux sin AppImage ni dpkg): se abre la página del release
          asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
          sumsUrl: sums.browser_download_url,
          inPlace: !!asset && canInstallInPlace()
        },
        error: null,
        checkedAt: Date.now()
      });
    } catch (err) {
      // Sin red o límite de GitHub: en una comprobación automática no se molesta a nadie
      set({ status: manual ? 'error' : state.status === 'checking' ? 'idle' : state.status, error: manual ? `No se pudo comprobar: ${err.message}` : null });
    } finally {
      busy = false;
    }
    return state;
  }

  /** Novedades: los últimos releases con sus notas (para el botón de la versión) */
  async function releases() {
    if (releasesCache && Date.now() - releasesCache.at < RELEASES_TTL_MS) return releasesCache.list;
    const res = await fetch(`${API_BASE}/releases?per_page=15`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    const list = summarizeReleases(await res.json());
    releasesCache = { at: Date.now(), list };
    return list;
  }

  /** Descarga `url` a `file` comprobando el hash; devuelve el SHA-256 calculado */
  async function download(url, file, total) {
    const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`La descarga falló (${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file, { mode: 0o755 });
    let received = 0;
    let lastPublish = 0;
    const size = total || Number(res.headers.get('content-length')) || 0;
    await new Promise((resolve, reject) => {
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (size && Date.now() - lastPublish > 250) { lastPublish = Date.now(); set({ progress: Math.min(99, Math.round((received / size) * 100)) }); }
      });
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      body.pipe(out);
    });
    if (size && received !== size) throw new Error(`La descarga se cortó (${received} de ${size} bytes)`);
    return hash.digest('hex');
  }

  async function expectedHash(sumsUrl, assetName) {
    if (!sumsUrl) return null;
    const res = await fetch(sumsUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    for (const line of (await res.text()).split('\n')) {
      const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (m && m[2].trim() === assetName) return m[1].toLowerCase();
    }
    return null;
  }

  /** Descargar la nueva versión e instalarla (o abrir su instalador) */
  async function install() {
    const latest = state.latest;
    if (!latest || state.status === 'downloading') return state;
    if (!latest.asset) { shell.openExternal(latest.page); return state; }

    set({ status: 'downloading', progress: 0, error: null, justUpdated: null });
    log('descargando', latest.asset.name, latest.inPlace ? '(en el sitio)' : '(instalador)', process.env.APPIMAGE || process.execPath);
    try {
      const dir = path.join(app.getPath('temp'), 'zer0code-update');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(latest.inPlace ? dir : app.getPath('downloads'), latest.asset.name);
      const expected = await expectedHash(latest.sumsUrl, latest.asset.name);
      if (!expected) throw new Error('El release no incluye la suma de comprobación (SHA256SUMS.txt): descarga la actualización desde GitHub.');
      const got = await download(latest.asset.url, target, latest.asset.size);
      if (got !== expected) {
        fs.rmSync(target, { force: true });
        throw new Error('La descarga no coincide con la suma de comprobación: se ha descartado.');
      }
      set({ status: 'ready', progress: 100 });

      if (!latest.inPlace) {
        // .deb y macOS: el instalador del sistema se encarga
        const problem = await shell.openPath(target);
        if (problem) throw new Error(`No se pudo abrir el instalador (${problem}). Está en ${target}`);
        rememberPending(latest.version, target);
        set({ status: 'opened' });
        return state;
      }
      applyInPlace(target, latest.version);
    } catch (err) {
      log('error', err.message);
      set({ status: 'error', error: err.message });
    }
    return state;
  }

  function rememberPending(version, target) {
    const cfg = getConfig();
    cfg.pendingUpdate = { version, from: state.current, target, at: Date.now() };
    saveConfig();
  }

  function applyInPlace(file, version) {
    if (process.platform === 'win32') {
      rememberPending(version, file);
      // Instalación silenciosa encima de la actual (los mismos argumentos que usa electron-updater); --force-run hace que el instalador abra la app al terminar.
      // El instalador espera a que esta app se cierre (y la cierra si hace falta).
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log('instalador lanzado', file);
      quit();
      return;
    }
    // AppImage: se sustituye el archivo (el proceso actual sigue con su copia montada) y se relanza
    const current = process.env.APPIMAGE;
    const staged = `${current}.update`;
    try {
      fs.copyFileSync(file, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, current);
    } catch (err) {
      fs.rmSync(staged, { force: true });
      throw new Error(`No se pudo reemplazar ${current}: ${err.message}`);
    }
    fs.rmSync(file, { force: true });
    rememberPending(version, current);
    log('AppImage reemplazado', current);
    // Antes se lanzaba la app nueva con spawn() mientras esta seguía abierta: la nueva veía el bloqueo de
    // instancia única y se cerraba al momento. app.relaunch() la abre cuando esta ya ha terminado.
    app.relaunch({ execPath: current, args: process.argv.slice(1) });
    quit();
  }

  function skip(version) {
    const cfg = getConfig();
    cfg.skippedUpdate = version;
    saveConfig();
    set({ status: 'uptodate', latest: null });
  }

  /** La ventana ya ha enseñado el aviso de «actualizado» / «no se aplicó» */
  function dismissNotice() {
    set({ justUpdated: null });
  }

  function start() {
    verifyPendingUpdate();
    setTimeout(() => check(), FIRST_CHECK_MS).unref?.();
    timer = setInterval(() => check(), CHECK_EVERY_MS);
    timer.unref?.();
  }

  return { state: () => ({ ...state }), check, install, skip, releases, dismissNotice, start };
}

module.exports = { createUpdater };
