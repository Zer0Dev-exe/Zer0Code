import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';

const raiz = fileURLToPath(new URL('../', import.meta.url));

// http.request conserva los segmentos codificados, sin normalizarlos como fetch/URL.
function solicitar(puerto, ruta) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: puerto, path: ruta, timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
  });
}

test('vendor: servidor real, lista cerrada de archivos y bibliotecas locales', { timeout: 30000 }, async (t) => {
  const temporal = await mkdtemp(path.join(os.tmpdir(), 'zer0code-vendor-'));
  t.after(() => rm(temporal, { recursive: true, force: true }));
  const reserva = net.createServer();
  reserva.listen(0, '127.0.0.1');
  await once(reserva, 'listening');
  const puerto = reserva.address().port;
  await new Promise((resolve, reject) => reserva.close((error) => error ? reject(error) : resolve()));
  const envFile = path.join(temporal, '.env');
  await writeFile(envFile, `PORT=${puerto}\nHOST=127.0.0.1\n`);
  const env = { ...process.env, ZER0CODE_DATA_DIR: temporal, ZER0CODE_ENV_FILE: envFile };
  delete env.PORT;
  delete env.HOST;
  const hijo = spawn(process.execPath, ['server/index.js'], { cwd: raiz, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  let errorProceso;
  hijo.on('error', (error) => { errorProceso = error; });
  hijo.stdout.on('data', (chunk) => { salida += chunk; });
  hijo.stderr.on('data', (chunk) => { salida += chunk; });
  t.after(async () => {
    if (hijo.exitCode !== null || hijo.signalCode !== null) return;
    const terminado = once(hijo, 'exit');
    hijo.kill('SIGTERM');
    const limite = setTimeout(() => hijo.kill('SIGKILL'), 3000);
    try { await terminado; } finally { clearTimeout(limite); }
  });

  const limite = Date.now() + 20000;
  while (true) {
    if (errorProceso) throw errorProceso;
    assert.equal(hijo.exitCode, null, salida);
    try {
      if ((await solicitar(puerto, '/manifest.json')).status === 200) break;
    } catch { /* El servidor aún está arrancando. */ }
    assert.ok(Date.now() < limite, `El servidor no arrancó: ${salida}`);
    await esperar(100);
  }

  for (const [archivo, original] of [
    ['marked.js', 'node_modules/marked/lib/marked.umd.js'],
    ['purify.js', 'node_modules/dompurify/dist/purify.min.js']
  ]) {
    const respuesta = await solicitar(puerto, `/vendor/${archivo}`);
    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers['content-type'], /(?:application|text)\/javascript/);
    assert.equal(respuesta.body, await readFile(path.join(raiz, original), 'utf8'));
  }
  for (const ruta of [
    '/vendor/otro.js',
    '/vendor/%2e%2e/package.json',
    '/vendor/%2e%2e%2fpackage.json',
    '/vendor/..%2fserver%2findex.js',
    '/vendor/%2e%2e%5cpackage.json'
  ]) {
    assert.equal((await solicitar(puerto, ruta)).status, 404, ruta);
  }
  const pagina = await solicitar(puerto, '/');
  assert.equal(pagina.status, 200);
  for (const archivo of ['marked', 'purify']) {
    assert.match(pagina.body, new RegExp(`<script\\s+src=["']/?vendor/${archivo}\\.js["']`));
  }
  assert.doesNotMatch(pagina.body, /cdn\.jsdelivr\.net/);
});
