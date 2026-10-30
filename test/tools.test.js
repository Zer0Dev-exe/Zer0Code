import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { toolSpecs, tarExtractor } from '../server/toolsManager.js';

test('herramientas: paquete de cada sistema', () => {
  const linux = toolSpecs({ platform: 'linux', arch: 'x64', musl: false });
  assert.deepEqual(linux.claude.package('2.1.314'), { name: '@anthropic-ai/claude-code-linux-x64', version: '2.1.314' });
  assert.equal(linux.claude.entry, 'claude');
  assert.deepEqual(linux.codex.package('0.163.0'), { name: '@openai/codex', version: '0.163.0-linux-x64' });
  assert.equal(linux.codex.entry, 'vendor/x86_64-unknown-linux-musl/bin/codex');
  assert.equal(linux.codex.keep('vendor/x86_64-unknown-linux-musl/bin/codex'), true);
  assert.equal(linux.codex.keep('vendor/x86_64-unknown-linux-musl/codex-resources/voice/bin/x'), false);
  assert.equal(linux.gemini.keep('bundle/gemini.js'), true);
  assert.equal(linux.gemini.keep('README.md'), false);

  const alpine = toolSpecs({ platform: 'linux', arch: 'arm64', musl: true });
  assert.equal(alpine.claude.package('2.1.0').name, '@anthropic-ai/claude-code-linux-arm64-musl');

  const win = toolSpecs({ platform: 'win32', arch: 'x64' });
  assert.equal(win.claude.entry, 'claude.exe');
  assert.equal(win.codex.entry, 'vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  assert.equal(win.gemini.entry, 'gemini.cmd');
  assert.equal(toolSpecs({ platform: 'freebsd', arch: 'x64' }).codex, null);
});

// Tar mínimo (ustar) para probar el extractor
function tarEntry(name, content, { mode = 0o644, type = '0' } = {}) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0);
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}
function pax(name) {
  const record = (len) => `${len} path=${name}\n`;
  let len = record(0).length;
  while (record(len).length !== len) len = record(len).length;
  return tarEntry('PaxHeader', record(len), { type: 'x' });
}

test('herramientas: el extractor saca solo lo pedido, con permisos y sin salirse de la carpeta', async () => {
  const longName = `package/bundle/${'muy-largo-'.repeat(12)}chunk.js`;
  const tar = Buffer.concat([
    tarEntry('package/claude', 'binario', { mode: 0o755 }),
    tarEntry('package/README.md', 'léeme'),
    pax(longName), tarEntry('package/bundle/truncado', 'código'),
    tarEntry('package/../fuera.txt', 'no'),
    tarEntry('otro/claude', 'no'),
    Buffer.alloc(1024)
  ]);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-tar-'));
  const keep = (f) => f === 'claude' || f.startsWith('bundle/');
  await pipeline(Readable.from([zlib.gzipSync(tar)]), zlib.createGunzip(), tarExtractor(dest, keep));

  assert.equal(fs.readFileSync(path.join(dest, 'claude'), 'utf-8'), 'binario');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dest, 'claude')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(dest, longName.replace('package/', '')), 'utf-8'), 'código');
  assert.equal(fs.existsSync(path.join(dest, 'README.md')), false);
  assert.equal(fs.existsSync(path.join(dest, '..', 'fuera.txt')), false);
  assert.equal(fs.existsSync(path.join(dest, 'bundle', 'truncado')), false);
});
