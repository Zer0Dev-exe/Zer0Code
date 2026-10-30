import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0code-login-ip-'));
const previousDataDir = process.env.ZER0CODE_DATA_DIR;
process.env.ZER0CODE_DATA_DIR = directory;
// paths.js fija el directorio al importarse: auth debe cargarse después de configurar el entorno.
const { clientIp, login, logout } = await import('../server/auth.js');
const username = process.env.ZER0CODE_USER || 'admin';
const password = process.env.ZER0CODE_PASSWORD || 'zer0code';
const wrongPassword = `${password}-incorrecta`;

after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.ZER0CODE_DATA_DIR;
  else process.env.ZER0CODE_DATA_DIR = previousDataDir;
});

function request(peer, headers = {}) {
  return { socket: { remoteAddress: peer }, headers };
}

for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  test(`clientIp acepta las cabeceras del proxy local ${peer}`, () => {
    assert.equal(clientIp(request(peer, { 'cf-connecting-ip': ' 203.0.113.10 ' })), '203.0.113.10');
    assert.equal(clientIp(request(peer, { 'x-real-ip': '2001:db8::10' })), '2001:db8::10');
    assert.equal(clientIp(request(peer, {
      'x-forwarded-for': '198.51.100.99, 203.0.113.20, 2001:db8::20 '
    })), '2001:db8::20');
    assert.equal(clientIp(request(peer, {
      'cf-connecting-ip': '203.0.113.30',
      'x-real-ip': '203.0.113.31',
      'x-forwarded-for': '203.0.113.32'
    })), '203.0.113.30');
    assert.equal(clientIp(request(peer, {
      'x-real-ip': '203.0.113.31', 'x-forwarded-for': '203.0.113.32'
    })), '203.0.113.31');
  });
}

test('clientIp ignora cabeceras falsificadas desde conexiones no locales', () => {
  for (const peer of ['198.51.100.10', '2001:db8::10']) {
    for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
      assert.equal(clientIp(request(peer, { [header]: '203.0.113.99' })), peer);
    }
    // La IP del socket prevalece sobre la que pueda indicar req.ip.
    assert.equal(clientIp({ ...request(peer, { 'cf-connecting-ip': '203.0.113.99' }), ip: '127.0.0.1' }), peer);
  }
});

test('clientIp descarta cabeceras que no parecen direcciones IP', () => {
  for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
    for (const value of ['no-es-una-ip', 'https://example.com', '1', 'a'.repeat(46), '']) {
      assert.equal(clientIp(request('127.0.0.1', { [header]: value })), '127.0.0.1');
    }
  }
  assert.equal(clientIp(request('::1', { 'x-forwarded-for': '203.0.113.10, no-es-una-ip' })), '::1');
});

test('clientIp usa la conexión o req.ip como alternativa y devuelve desconocida sin datos', () => {
  assert.equal(clientIp(request('127.0.0.1')), '127.0.0.1');
  assert.equal(clientIp({ ip: '198.51.100.20' }), '198.51.100.20');
  for (const req of [undefined, null, {}, { headers: { 'cf-connecting-ip': '203.0.113.10' } }]) {
    assert.equal(clientIp(req), 'desconocida');
  }
});

test('login bloquea tras cinco fallos solo la IP real y libera el bloqueo a los 15 minutos', t => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const blocked = request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.100' });
  const other = request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.101' });
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = login(username, wrongPassword, blocked);
    assert.equal(result.success, false);
    if (attempt < 4) assert.notEqual(result.locked, true);
  }
  const assertLocked = () => {
    const result = login(username, password, blocked);
    assert.equal(result.success, false);
    assert.equal(result.locked, true);
  };
  assertLocked();
  const otherFailure = login(username, wrongPassword, other);
  assert.equal(otherFailure.success, false);
  assert.notEqual(otherFailure.locked, true);
  const otherSuccess = login(username, password, other);
  assert.equal(otherSuccess.success, true);
  logout(otherSuccess.token);
  now = start + 15 * 60 * 1000 - 1;
  assertLocked();
  now += 1;
  const recovered = login(username, password, blocked);
  assert.equal(recovered.success, true);
  logout(recovered.token);
});

test('login borra el contador de fallos después de un acierto', () => {
  const req = request('::1', { 'x-real-ip': '203.0.113.102' });
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(login(username, wrongPassword, req).success, false);
  }
  const success = login(username, password, req);
  assert.equal(success.success, true);
  logout(success.token);
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = login(username, wrongPassword, req);
    assert.equal(result.success, false);
    assert.notEqual(result.locked, true);
  }
  // Si el acierto no hubiese borrado los fallos anteriores, esta entrada estaría bloqueada.
  const nextSuccess = login(username, password, req);
  assert.equal(nextSuccess.success, true);
  logout(nextSuccess.token);
});
