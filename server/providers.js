import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeTask, EFFORT_LEVELS } from './claudeRunner.js';
import { executeCodexTask, getCodexBinary } from './codexRunner.js';
import { executeGeminiTask, getGeminiBinary } from './geminiRunner.js';
import { geminiPackageDir } from './toolsManager.js';
import { executeAgyTask, getAgyBinary, hasAgy } from './agyRunner.js';

// Proveedores: cada uno usa la suscripción de su CLI oficial (Claude Code, Codex, Gemini CLI)
export const PROVIDERS = {
  claude: { name: 'Claude', cli: 'Claude Code' },
  codex: { name: 'ChatGPT', cli: 'Codex' },
  gemini: { name: 'Gemini', get cli() { return useAgy() ? 'Antigravity CLI' : 'Gemini CLI'; } }
};

// Gemini se puede usar con Antigravity CLI (suscripción de Google AI) o con Gemini CLI.
// La elección se guarda aparte del resto de la configuración.
const GEMINI_BACKENDS = ['antigravity', 'gemini'];
const GEMINI_BACKEND_FILE = path.join(os.homedir(), '.zer0code_gemini.json');
let geminiBackend = null;
try {
  const saved = JSON.parse(fs.readFileSync(GEMINI_BACKEND_FILE, 'utf-8')).backend;
  if (GEMINI_BACKENDS.includes(saved)) geminiBackend = saved;
} catch {
  // sin elección guardada: Antigravity si está instalado
}

function useAgy() {
  return hasAgy() && geminiBackend !== 'gemini';
}

export function getGeminiBackend() {
  return useAgy() ? 'antigravity' : 'gemini';
}

export function setGeminiBackend(backend) {
  if (!GEMINI_BACKENDS.includes(backend)) throw new Error('Opción de Gemini no válida');
  if (backend === 'antigravity' && !hasAgy()) throw new Error('Antigravity CLI no está instalado');
  geminiBackend = backend;
  fs.writeFileSync(GEMINI_BACKEND_FILE, JSON.stringify({ backend }, null, 2));
  statusCache = null;
}

/**
 * Proveedor de un modelo: los de ChatGPT y Gemini llevan `provider` en el catálogo; por el id como respaldo
 */
export function providerOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/^(gpt|o\d|codex)/.test(id)) return 'codex';
  if (id.includes('gemini')) return 'gemini';
  return 'claude';
}

// --------------------------------------------------------------------------
// Catálogo de modelos de ChatGPT (lo publica Codex) y de Gemini
// --------------------------------------------------------------------------
const CODEX_FALLBACK = [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] }];
const CODEX_REFRESH_MS = 60 * 60 * 1000;
let codexCatalog = null;
let codexCatalogAt = 0;

function refreshCodexCatalog() {
  if (Date.now() - codexCatalogAt < CODEX_REFRESH_MS) return;
  codexCatalogAt = Date.now();
  execFile(getCodexBinary(), ['debug', 'models'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout) => {
    if (err) return;
    try {
      const parsed = JSON.parse(stdout);
      const list = (parsed.models || parsed).filter(m => m.visibility === 'list');
      if (list.length) codexCatalog = list;
    } catch {
      // se queda el catálogo anterior
    }
  });
}

function codexModels() {
  refreshCodexCatalog();
  return (codexCatalog || CODEX_FALLBACK).map((m, i) => ({
    id: m.slug,
    name: m.display_name || m.slug,
    tag: 'ChatGPT',
    badge: 'ChatGPT',
    desc: m.description || 'Con tu suscripción de ChatGPT (Codex)',
    provider: 'codex',
    effortLevels: (m.supported_reasoning_levels || [])
      .map(r => (typeof r === 'string' ? r : r.effort))
      .filter(level => EFFORT_LEVELS.includes(level)),
    ...(i === 0 ? { providerDefault: true } : {})
  }));
}

// Gemini: el catálogo sale del propio Gemini CLI instalado (sus modelDefinitions), así siempre
// coincide con lo que el CLI sabe ejecutar. Con GEMINI_API_KEY se completa con la API de Google.
const GEMINI_FALLBACK = [
  { id: 'gemini-3.1-pro-preview', tier: 'pro', isPreview: true },
  { id: 'gemini-3.5-flash', tier: 'flash', isPreview: false }
];
const GEMINI_REFRESH_MS = 60 * 60 * 1000;
const GEMINI_TIER_ORDER = { pro: 0, flash: 1, 'flash-lite': 2 };
const GEMINI_TIER_DESC = {
  pro: 'El más capaz de Gemini',
  flash: 'Rápido para tareas del día a día',
  'flash-lite': 'El más ligero y rápido'
};
let geminiCatalog = null;
let geminiCatalogAt = 0;

function geminiBundleDir() {
  const pkg = geminiPackageDir();
  return pkg ? path.join(pkg, 'bundle') : null;
}

/** Lee los modelos visibles de los modelDefinitions del bundle de Gemini CLI */
function readGeminiCliCatalog() {
  const dir = geminiBundleDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const entry = /"(gemini-[\w.-]+)":\s*\{\s*(?:displayName:\s*"[^"]*",\s*)?tier:\s*"([^"]+)",\s*family:\s*"[^"]+",\s*isPreview:\s*(true|false),\s*isVisible:\s*(true|false)/g;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf-8');
    const at = text.indexOf('modelDefinitions: {\n    // Concrete Models');
    if (at === -1) continue;
    const block = text.slice(at, text.indexOf('// Aliases', at));
    const models = [];
    for (const m of block.matchAll(entry)) {
      if (m[4] === 'true') models.push({ id: m[1], tier: m[2], isPreview: m[3] === 'true' });
    }
    if (models.length) return models;
  }
  return [];
}

/** Modelos de la API de Gemini (solo si hay GEMINI_API_KEY en el .env) */
async function fetchGeminiApiCatalog() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(id => /^gemini-\d/.test(id) && !/(image|tts|audio|live|embedding|computer-use|-\d{2,}$)/.test(id))
    .map(id => ({
      id,
      tier: id.includes('flash-lite') ? 'flash-lite' : id.includes('flash') ? 'flash' : 'pro',
      isPreview: /preview|exp/.test(id)
    }));
}

function refreshGeminiCatalog() {
  if (Date.now() - geminiCatalogAt < GEMINI_REFRESH_MS) return;
  geminiCatalogAt = Date.now();
  const fromCli = readGeminiCliCatalog();
  if (fromCli.length) geminiCatalog = fromCli;
  fetchGeminiApiCatalog()
    .then(fromApi => {
      if (!fromApi.length) return;
      const known = new Set((geminiCatalog || []).map(m => m.id));
      geminiCatalog = [...(geminiCatalog || []), ...fromApi.filter(m => !known.has(m.id))];
    })
    .catch(() => {
      // se queda el catálogo del CLI
    });
}

/** gemini-3.1-pro-preview -> { version: 3.1, name: 'Gemini 3.1 Pro' } */
function geminiLabel(id) {
  const [, version = '0', rest = ''] = id.match(/^gemini-([\d.]+)-?(.*)$/) || [];
  const words = rest.replace(/-?preview/, '').split('-').filter(Boolean)
    .map(w => (w === 'lite' ? 'Lite' : w[0].toUpperCase() + w.slice(1)));
  return { version: parseFloat(version), name: `Gemini ${version} ${words.join(' ')}`.trim() };
}

// Antigravity CLI (sustituye a Gemini CLI para Google AI Pro/Ultra): `agy models` lista lo que permite
// la cuenta, una entrada por esfuerzo (gemini-3.8-flash-high/-medium/-low). Se agrupan en un modelo
// con sus niveles de esfuerzo, que el runner pasa con --effort.
const AGY_EFFORTS = ['low', 'medium', 'high'];
let agyCatalog = null;
let agyCatalogAt = 0;

function refreshAgyCatalog() {
  if (Date.now() - agyCatalogAt < GEMINI_REFRESH_MS) return;
  agyCatalogAt = Date.now();
  execFile(getAgyBinary(), ['models'], { timeout: 60000, maxBuffer: 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout) => {
    if (err) return;
    const groups = new Map();
    for (const line of stdout.split('\n')) {
      const [slug, display] = line.split('\t').map(x => x && x.trim());
      if (!slug || !display || !/^gemini-/.test(slug)) continue;
      const [, base = slug, effort] = slug.match(/^(.*?)(?:-(low|medium|high))?$/) || [];
      if (!groups.has(base)) groups.set(base, { id: base, name: display.replace(/\s*\((High|Medium|Low)\)$/, ''), efforts: [] });
      if (effort) groups.get(base).efforts.push(effort);
    }
    if (groups.size) agyCatalog = [...groups.values()];
  });
}

function agyModels() {
  refreshAgyCatalog();
  return (agyCatalog || [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: AGY_EFFORTS }]).map((m, i) => {
    const tier = m.id.includes('flash-lite') ? 'flash-lite' : m.id.includes('flash') ? 'flash' : 'pro';
    return {
      id: m.id,
      name: m.name,
      desc: `${GEMINI_TIER_DESC[tier] || 'Modelo de Gemini'} · con tu suscripción de Google AI`,
      tag: 'Gemini',
      badge: 'Gemini',
      provider: 'gemini',
      effortLevels: AGY_EFFORTS.filter(level => m.efforts.includes(level) && EFFORT_LEVELS.includes(level)),
      ...(i === 0 ? { providerDefault: true } : {})
    };
  });
}

function geminiModels() {
  if (useAgy()) return agyModels();
  refreshGeminiCatalog();
  const sorted = (geminiCatalog || GEMINI_FALLBACK)
    .map(m => ({ ...m, ...geminiLabel(m.id) }))
    .sort((a, b) => b.version - a.version || (GEMINI_TIER_ORDER[a.tier] ?? 9) - (GEMINI_TIER_ORDER[b.tier] ?? 9) || a.isPreview - b.isPreview);
  const models = [
    { id: 'auto-gemini-3', name: 'Gemini Auto', desc: 'Elige entre Pro y Flash según la tarea' },
    ...sorted.map(m => ({
      id: m.id,
      name: m.name,
      desc: `${GEMINI_TIER_DESC[m.tier] || 'Modelo de Gemini'}${m.isPreview ? ' · preview' : ''}`
    }))
  ];
  return models.map((m, i) => ({
    ...m,
    tag: 'Gemini',
    badge: 'Gemini',
    provider: 'gemini',
    effortLevels: [],
    ...(i === 0 ? { providerDefault: true } : {})
  }));
}

/**
 * Modelos de ChatGPT y Gemini que se añaden al catálogo de Claude
 */
export function getProviderModels() {
  return [...codexModels(), ...geminiModels()];
}

// --------------------------------------------------------------------------
// Estado de las cuentas
// --------------------------------------------------------------------------
const STATUS_TTL_MS = 30 * 1000;
let statusCache = null;
let statusAt = 0;

export function getProvidersStatus() {
  if (statusCache && Date.now() - statusAt < STATUS_TTL_MS) return statusCache;
  let codex = false;
  try {
    // Codex escribe el estado en stderr y sale con código 1 si no hay sesión
    execFileSync(getCodexBinary(), ['login', 'status'], { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    codex = true;
  } catch {
    codex = false;
  }
  const gemini = useAgy()
    ? fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
    : fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  statusCache = {
    codex: { loggedIn: codex },
    gemini: { loggedIn: gemini, backend: getGeminiBackend(), backends: hasAgy() ? GEMINI_BACKENDS : ['gemini'] }
  };
  statusAt = Date.now();
  return statusCache;
}

// --------------------------------------------------------------------------
// Ejecutar con el proveedor del modelo
// --------------------------------------------------------------------------
export function executeWithProvider(provider, options) {
  if (provider === 'codex') return executeCodexTask(options);
  if (provider === 'gemini') return useAgy() ? executeAgyTask(options) : executeGeminiTask(options);
  return executeTask(options);
}
