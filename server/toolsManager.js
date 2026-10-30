// Herramientas de IA opcionales (Claude Code, Codex y Gemini CLI). Los instaladores ya no las llevan dentro
// (juntas ocupaban más de 700 MB): se instalan desde Ajustes cuando hacen falta. Se descargan del registro de
// npm el paquete de este sistema, se comprueba su integridad (sha512) y se descomprimen en <datos>/tools, sin
// necesitar npm. Si no están instaladas desde la app, se usan las de node_modules (desarrollo, VPS) o las del
// sistema (PATH).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { DATA_DIR, projectRoot } from './paths.js';

const REGISTRY = process.env.ZER0CODE_NPM_REGISTRY || 'https://registry.npmjs.org';
export const TOOLS_DIR = path.join(DATA_DIR, 'tools');
const isWin = process.platform === 'win32';

// Versiones probadas con Zer0Code: las de package.json (optionalDependencies)
function pinnedVersions() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    return { ...pkg.dependencies, ...pkg.optionalDependencies };
  } catch {
    return {};
  }
}

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report?.getReport?.().header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

const CODEX_TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
};

/** Qué descargar de cada herramienta para este sistema */
export function toolSpecs({ platform = process.platform, arch = process.arch, musl = isMusl() } = {}) {
  const plat = `${platform}-${arch}`;
  const exe = platform === 'win32' ? '.exe' : '';
  const triple = CODEX_TRIPLES[plat];
  return {
    claude: {
      id: 'claude',
      label: 'Claude Code',
      command: 'claude',
      sizeMB: 300,
      source: '@anthropic-ai/claude-code',
      // El paquete principal solo apunta al de cada plataforma, que trae el binario
      package: (version) => ({ name: `@anthropic-ai/claude-code-${plat}${musl ? '-musl' : ''}`, version }),
      keep: (file) => file === `claude${exe}`,
      entry: `claude${exe}`
    },
    codex: triple ? {
      id: 'codex',
      label: 'Codex (ChatGPT)',
      command: 'codex',
      sizeMB: 330,
      source: '@openai/codex',
      package: (version) => ({ name: '@openai/codex', version: `${version}-${plat}` }),
      // Solo el binario y sus utilidades; el host de voz no hace falta
      keep: (file) => file.startsWith(`vendor/${triple}/`) && !file.startsWith(`vendor/${triple}/codex-resources/voice/`),
      entry: `vendor/${triple}/bin/codex${exe}`
    } : null,
    gemini: {
      id: 'gemini',
      label: 'Gemini CLI',
      command: 'gemini',
      sizeMB: 100,
      source: '@google/gemini-cli',
      package: (version) => ({ name: '@google/gemini-cli', version }),
      keep: (file) => file === 'package.json' || file.startsWith('bundle/'),
      // Un script de JavaScript: se lanza con Node mediante un lanzador
      entry: platform === 'win32' ? 'gemini.cmd' : 'gemini',
      launcher: true
    }
  };
}

const SPECS = toolSpecs();
export const TOOL_IDS = Object.keys(SPECS).filter(id => SPECS[id]);

const toolDir = (id) => path.join(TOOLS_DIR, id);
function readManifest(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(toolDir(id), 'zer0code-tool.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** Ruta del ejecutable instalado desde la app (o null) */
export function appToolBinary(id) {
  const spec = SPECS[id];
  if (!spec || !readManifest(id)) return null;
  const file = path.join(toolDir(id), spec.entry);
  return fs.existsSync(file) ? file : null;
}

function nodeModulesBinary(command) {
  for (const name of isWin ? [`${command}.cmd`, command] : [command]) {
    const file = path.join(projectRoot, 'node_modules', '.bin', name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function systemBinary(command) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [command], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

/** El ejecutable que usar para una herramienta: la de la app, la de node_modules o el comando del sistema */
export function toolBinary(id) {
  const spec = SPECS[id];
  if (!spec) return id;
  return appToolBinary(id) || nodeModulesBinary(spec.command) || (isWin ? `${spec.command}.cmd` : spec.command);
}

/** ¿Hay algún ejecutable de esta herramienta? (de la app, de node_modules o del sistema) */
export function toolAvailable(id) {
  const spec = SPECS[id];
  if (!spec) return true;
  return !!(appToolBinary(id) || nodeModulesBinary(spec.command) || systemBinary(spec.command));
}

export const toolLabel = (id) => SPECS[id]?.label || id;

/** Carpeta del paquete de Gemini CLI (para leer su catálogo de modelos) */
export function geminiPackageDir() {
  if (appToolBinary('gemini')) return toolDir('gemini');
  try {
    return fs.realpathSync(path.join(projectRoot, 'node_modules', '@google', 'gemini-cli'));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Estado
// --------------------------------------------------------------------------
const installs = new Map(); // id -> { status, progress, error }
let notify = () => {};
export function setToolsNotifier(fn) { notify = fn; }

const report = (id, patch) => {
  const next = { ...(installs.get(id) || {}), ...patch };
  installs.set(id, next);
  notify({ type: 'tool_install', id, ...next });
};

export function listTools() {
  return TOOL_IDS.map((id) => {
    const spec = SPECS[id];
    const manifest = readManifest(id);
    const app = appToolBinary(id);
    const bundled = !app && nodeModulesBinary(spec.command);
    const system = !app && !bundled ? systemBinary(spec.command) : null;
    const job = installs.get(id);
    return {
      id,
      label: spec.label,
      sizeMB: spec.sizeMB,
      installed: !!(app || bundled || system),
      source: app ? 'app' : bundled ? 'bundled' : system ? 'system' : null,
      version: app ? manifest.version : null,
      installing: job?.status === 'installing',
      progress: job?.status === 'installing' ? job.progress || 0 : null,
      error: job?.status === 'error' ? job.error : null
    };
  });
}

// --------------------------------------------------------------------------
// Instalar
// --------------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`El registro de npm respondió ${res.status} (${url})`);
  return res.json();
}

/** Versión a instalar: la fijada; con ^x.y.z, la última de esa versión mayor */
async function resolveVersion(spec) {
  const wanted = String(pinnedVersions()[spec.source] || 'latest');
  const exact = wanted.replace(/^[\^~=v]+/, '');
  if (!wanted.startsWith('^') && /^\d+\.\d+\.\d+/.test(exact)) return exact;
  const latest = (await getJson(`${REGISTRY}/${spec.source.replace('/', '%2F')}/latest`)).version;
  if (!/^\d/.test(exact)) return latest;
  return latest.split('.')[0] === exact.split('.')[0] ? latest : exact;
}

/**
 * Lee un .tgz de npm en streaming y escribe en `dest` los archivos de `package/` que acepta `keep(ruta)`.
 * Formato tar ustar con cabeceras pax y nombres largos de GNU.
 */
export function tarExtractor(dest, keep) {
  let buf = Buffer.alloc(0);
  let file = null; // { remaining, pad, fd | null }
  let longName = null;
  let paxPath = null;
  const destRoot = path.resolve(dest);

  const parseOctal = (b) => parseInt(b.toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
  const openEntry = (name, size, mode, type) => {
    const rel = name.replace(/^package\//, '');
    const target = path.resolve(destRoot, rel);
    const safe = name.startsWith('package/') && (target + path.sep).startsWith(destRoot + path.sep);
    let fd = null;
    if (safe && (type === '0' || type === '\0') && keep(rel)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fd = fs.openSync(target, 'w', (mode & 0o111) ? 0o755 : 0o644);
    }
    return { remaining: size, pad: (512 - (size % 512)) % 512, fd, type, chunks: type === 'x' || type === 'L' ? [] : null };
  };

  return new Transform({
    transform(chunk, _enc, done) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (file) {
            if (file.remaining > 0) {
              if (!buf.length) break;
              const take = Math.min(file.remaining, buf.length);
              const part = buf.subarray(0, take);
              if (file.fd !== null) fs.writeSync(file.fd, part);
              if (file.chunks) file.chunks.push(Buffer.from(part));
              file.remaining -= take;
              buf = buf.subarray(take);
              if (file.remaining > 0) break;
            }
            if (buf.length < file.pad) break;
            buf = buf.subarray(file.pad);
            if (file.fd !== null) fs.closeSync(file.fd);
            if (file.type === 'L') longName = Buffer.concat(file.chunks).toString('utf-8').replace(/\0.*$/s, '');
            if (file.type === 'x') {
              const m = Buffer.concat(file.chunks).toString('utf-8').match(/\d+ path=([^\n]*)\n/);
              if (m) paxPath = m[1];
            }
            file = null;
          }
          if (buf.length < 512) break;
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (header.every(b => b === 0)) continue; // fin del archivo (bloques vacíos)
          const type = String.fromCharCode(header[156]);
          const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0.*$/s, '');
          const base = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/s, '');
          let name = paxPath || longName || (prefix ? `${prefix}/${base}` : base);
          if (type !== 'x' && type !== 'L' && type !== 'g') { paxPath = null; longName = null; }
          if (type === 'g') name = '';
          file = openEntry(name, parseOctal(header.subarray(124, 136)), parseOctal(header.subarray(100, 108)), type);
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      if (file?.fd) fs.closeSync(file.fd);
      done(file && file.remaining > 0 ? new Error('El paquete descargado está incompleto') : null);
    }
  });
}

function writeLauncher(dir, spec) {
  const script = path.join(dir, 'bundle', 'gemini.js');
  if (!fs.existsSync(script)) throw new Error('El paquete de Gemini CLI no trae bundle/gemini.js');
  // `node` del PATH: en la app de escritorio es el atajo al Node de Electron, que cambia de sitio en cada arranque
  if (isWin) fs.writeFileSync(path.join(dir, spec.entry), '@echo off\r\nnode "%~dp0bundle\\gemini.js" %*\r\n');
  else fs.writeFileSync(path.join(dir, spec.entry), '#!/bin/sh\nexec node "$(dirname "$0")/bundle/gemini.js" "$@"\n', { mode: 0o755 });
}

/** Descarga e instala una herramienta (solo una a la vez por herramienta) */
export async function installTool(id) {
  const spec = SPECS[id];
  if (!spec) throw new Error('Herramienta desconocida para este sistema');
  if (installs.get(id)?.status === 'installing') return;
  report(id, { status: 'installing', progress: 0, error: null });
  const staging = path.join(TOOLS_DIR, `.${id}-${Date.now()}`);
  try {
    const version = await resolveVersion(spec);
    const { name, version: pkgVersion } = spec.package(version);
    const meta = await getJson(`${REGISTRY}/${name.replace('/', '%2F')}/${encodeURIComponent(pkgVersion)}`);
    const { tarball, integrity } = meta.dist || {};
    if (!tarball || !/^sha512-/.test(integrity || '')) throw new Error('El paquete no tiene suma de integridad sha512');

    const res = await fetch(tarball, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`La descarga falló (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha512');
    let received = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk, _enc, done) {
        hash.update(chunk);
        received += chunk.length;
        if (total && Date.now() - lastReport > 300) {
          lastReport = Date.now();
          report(id, { progress: Math.min(99, Math.round((received / total) * 100)) });
        }
        done(null, chunk);
      }
    });
    fs.mkdirSync(staging, { recursive: true });
    await pipeline(Readable.fromWeb(res.body), meter, zlib.createGunzip(), tarExtractor(staging, spec.keep));
    if (`sha512-${hash.digest('base64')}` !== integrity) throw new Error('La descarga no coincide con la suma de integridad: se ha descartado');

    if (spec.launcher) writeLauncher(staging, spec);
    if (!fs.existsSync(path.join(staging, spec.entry))) throw new Error(`El paquete no trae ${spec.entry}`);
    fs.writeFileSync(path.join(staging, 'zer0code-tool.json'), JSON.stringify({ id, package: name, version, entry: spec.entry, installedAt: Date.now() }, null, 2));

    // Cambio atómico: la versión anterior (si había) se borra después
    const dir = toolDir(id);
    const old = fs.existsSync(dir) ? `${dir}.old-${Date.now()}` : null;
    if (old) fs.renameSync(dir, old);
    fs.renameSync(staging, dir);
    if (old) fs.rmSync(old, { recursive: true, force: true });
    report(id, { status: 'done', progress: 100, version });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    report(id, { status: 'error', error: err.message });
    throw err;
  }
}

/** Desinstalar la copia instalada desde la app (las de node_modules o del sistema no se tocan) */
export function uninstallTool(id) {
  if (!SPECS[id]) throw new Error('Herramienta desconocida');
  fs.rmSync(toolDir(id), { recursive: true, force: true });
  installs.delete(id);
  notify({ type: 'tool_install', id, status: 'removed' });
}

