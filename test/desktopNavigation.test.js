import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createNavigationGuard } = require('../desktop/navigation.js');
const connectFile = path.resolve('desktop/connect.html');
const connectUrl = pathToFileURL(connectFile).href;
const createGuard = (options = {}) => createNavigationGuard({
  connectFile,
  getOrigin: () => 'https://servidor',
  platform: 'linux',
  ...options
});

test('permite connect.html con parámetros y fragmentos', () => {
  const { isConnectScreen } = createGuard();
  for (const suffix of ['', '?modo=remoto', '#conexion', '?modo=remoto#conexion']) {
    assert.equal(isConnectScreen(connectUrl + suffix), true, suffix);
  }
});

test('bloquea archivos ajenos, escapes de carpeta y URL inválidas', () => {
  const { isConnectScreen } = createGuard();
  for (const url of [
    new URL('../connect.html', connectUrl).href,
    `${connectUrl.slice(0, -'connect.html'.length)}../connect.html`,
    'file:///etc/passwd',
    pathToFileURL(path.resolve('desktop/otro.html')).href,
    'file://otro-servidor/connect.html',
    'file:///%ZZ',
    'https://servidor/connect.html',
    'URL inválida',
    null,
    undefined
  ]) {
    assert.equal(isConnectScreen(url), false, String(url));
  }
});

test('solo Windows ignora las mayúsculas de la ruta de conexión', () => {
  const differentCase = pathToFileURL(path.join(path.dirname(connectFile), 'CONNECT.HTML')).href;
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(createGuard({ platform }).isConnectScreen(differentCase), platform === 'win32', platform);
    assert.equal(createGuard({ platform }).isConnectScreen(connectUrl), true, platform);
  }
});

test('permite páginas del mismo origen exacto', () => {
  const { isAppUrl } = createGuard();
  for (const url of ['https://servidor', 'https://servidor/chat?modo=1#mensaje', 'https://servidor:443/']) {
    assert.equal(isAppUrl(url), true, url);
  }
});

test('bloquea prefijos engañosos, otros puertos, protocolos y URL inválidas', () => {
  const { isAppUrl } = createGuard();
  for (const url of [
    'https://servidor.evil.com',
    'https://servidor@evil.com',
    'https://servidor:8443',
    'http://servidor',
    'javascript:alert(1)',
    'data:text/html,hola',
    connectUrl,
    'URL inválida'
  ]) {
    assert.equal(isAppUrl(url), false, url);
  }
});

test('consulta el servidor actual y bloquea sus páginas al desconectarse', () => {
  let origin = null;
  const { isAppUrl } = createGuard({ getOrigin: () => origin });
  assert.equal(isAppUrl('https://servidor/chat'), false);
  origin = 'https://servidor';
  assert.equal(isAppUrl('https://servidor/chat'), true);
  origin = 'https://otro-servidor:8443';
  assert.equal(isAppUrl('https://servidor/chat'), false);
  assert.equal(isAppUrl('https://otro-servidor:8443/chat'), true);
  origin = null;
  for (const url of ['https://servidor', 'https://otro-servidor:8443', 'javascript:alert(1)', 'data:text/html,hola']) {
    assert.equal(isAppUrl(url), false, url);
  }
});
