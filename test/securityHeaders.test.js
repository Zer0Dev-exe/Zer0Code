import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = script => `'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`;
const directives = csp => new Map(csp.split(';').map(part => {
  const [name, ...values] = part.trim().split(/\s+/);
  return [name, values];
}));

function comprobarCsp(csp, scripts) {
  assert.ok(csp, 'La página debe incluir CSP');
  const policy = directives(csp);
  assert.deepEqual(policy.get('script-src'), ["'self'", ...scripts.map(hash)]);
  for (const [name, value] of [['object-src', "'none'"], ['frame-ancestors', "'none'"], ['base-uri', "'self'"], ['form-action', "'self'"]]) {
    assert.deepEqual(policy.get(name), [value], name);
  }
  assert.ok(!policy.get('script-src').includes("'unsafe-inline'"));
  assert.ok(!policy.get('script-src').includes("'unsafe-eval'"));
}

test('seguridad: pageCsp autoriza cada script por su contenido exacto y restringe las demás fuentes', async () => {
  // Aislamos la función real sin importar index.js (que arrancaría el servidor) ni modificar producción.
  const source = await fs.readFile(path.join(root, 'server/index.js'), 'utf8');
  const definition = source.match(/^function pageCsp\(html\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(definition, 'Debe encontrarse la función pageCsp del servidor');
  const pageCsp = vm.runInNewContext(`(${definition})`, { crypto });
  const scripts = ['\n  console.log("á, ñ y 🚀");\n', 'window.valor = 2;'];
  comprobarCsp(pageCsp(`<html>${scripts.map(s => `<script>${s}</script>`).join('')}<script src="/js/app.js"></script></html>`), scripts);
  comprobarCsp(pageCsp('<html><script src="/js/app.js"></script></html>'), []);
  comprobarCsp(pageCsp('<html></html>'), []);
  assert.notEqual(pageCsp('<script>x()</script>'), pageCsp('<script> x() </script>'));
});

async function puertoLibre() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('seguridad: el servidor real entrega cabeceras, CSP por página y HSTS solo con HTTPS', { timeout: 30000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zer0code-headers-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const port = await puertoLibre();
  const envFile = path.join(temporary, '.env');
  await fs.writeFile(envFile, `PORT=${port}\nHOST=127.0.0.1\n`);
  const env = { ...process.env, ZER0CODE_DATA_DIR: path.join(temporary, 'data'), ZER0CODE_ENV_FILE: envFile, ZER0CODE_OPEN_BROWSER: '0' };
  delete env.PORT;
  delete env.HOST;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let startupError;
  child.on('error', error => { startupError = error; });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.ifError(startupError);
    assert.equal(child.exitCode, null, `El servidor terminó durante el arranque: ${output}`);
    try {
      const response = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch { /* El puerto puede no estar escuchando todavía. */ }
    await delay(50);
  }
  assert.ok(ready, `El servidor no arrancó: ${output}`);

  const pageHashes = [];
  for (const route of ['/', '/desktop/', '/favicon.svg']) {
    for (const proto of [undefined, 'http', 'https']) {
      const response = await fetch(`${base}${route}`, {
        headers: proto ? { 'X-Forwarded-Proto': proto } : {},
        signal: AbortSignal.timeout(3000)
      });
      assert.equal(response.status, 200, route);
      const headers = response.headers;
      assert.equal(headers.get('permissions-policy'), 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)', route);
      assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin', route);
      assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin', route);
      assert.equal(headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(headers.get('x-frame-options'), 'DENY', route);
      assert.equal(headers.get('referrer-policy'), 'no-referrer', route);
      assert.equal(headers.get('strict-transport-security'), proto === 'https' ? 'max-age=15552000' : null, `${route}: ${proto ?? 'sin proxy'}`);
      const html = await response.text();
      if (route !== '/favicon.svg') {
        // Leemos los scripts del HTML servido, sin reutilizar el patrón de pageCsp.
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
          .filter(match => !/\bsrc\s*=/i.test(match[1])).map(match => match[2]);
        assert.ok(scripts.length > 0, `${route} debe tener scripts en línea para comprobar sus hashes`);
        comprobarCsp(headers.get('content-security-policy'), scripts);
        if (proto === undefined) pageHashes.push(scripts.map(hash));
      }
    }
  }
  assert.notDeepEqual(pageHashes[0], pageHashes[1], 'Cada página debe autorizar sus propios scripts');
});
