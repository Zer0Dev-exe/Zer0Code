const path = require('path');
const { fileURLToPath } = require('url');

/** Comprobaciones de navegación sin dependencias de Electron. */
function createNavigationGuard({ connectFile, getOrigin, platform = process.platform }) {
  const samePath = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  /** Solo la pantalla de conexión de la app, con o sin parámetros y fragmento. */
  function isConnectScreen(url) {
    try {
      const raw = String(url || '');
      if (!raw.startsWith('file:')) return false;
      return samePath(path.resolve(fileURLToPath(raw.split(/[?#]/)[0])), path.resolve(connectFile));
    } catch {
      return false;
    }
  }

  /** Solo páginas del origen exacto del servidor conectado. */
  function isAppUrl(url) {
    const origin = getOrigin();
    if (!origin) return false;
    try {
      return new URL(url).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  }

  return { isConnectScreen, isAppUrl };
}

module.exports = { createNavigationGuard };
