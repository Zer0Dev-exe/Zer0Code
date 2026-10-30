// Proyectos creados por el agente (como en T3 Code): cuando una conversación pide «créame esto» y no está en
// un proyecto adecuado, el modelo llama a la herramienta create_project de Zer0Code. Aquí se crea la carpeta
// (con git, README y un primer commit) o se elige una existente, y la conversación pasa a ese proyecto.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isRestricted, isPathAllowed } from './accessPolicy.js';

const GIT_TIMEOUT_MS = 15000;

/** «Mi App de Notas!» -> «mi-app-de-notas» */
export function slugify(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60) || 'proyecto';
}

/** Carpeta donde se crean los proyectos nuevos de este usuario */
export function projectsRoot(user, { env = process.env, home = os.homedir() } = {}) {
  if (isRestricted(user)) {
    // Solo puede escribir en sus carpetas: la primera que exista
    return (user.roots || []).find(r => fs.existsSync(r)) || null;
  }
  const configured = String(env.ZER0CODE_PROJECTS_DIR || '').trim();
  return configured ? path.resolve(configured) : path.join(home, 'Projects');
}

/** Una carpeta libre: nombre, nombre-2, nombre-3… */
export function freeFolder(root, slug) {
  let candidate = path.join(root, slug);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(root, `${slug}-${n}`);
  return candidate;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

/**
 * Crea (o adopta) la carpeta del proyecto. Devuelve { dir, name, created, git, commitError? }.
 * - `folder`: una carpeta que ya existe y se usa tal cual.
 * - Si no: una carpeta nueva en la de proyectos con git, README.md y un primer commit.
 */
export function createProject(user, { name, folder, description } = {}, options = {}) {
  const title = String(name || '').trim().slice(0, 80);
  if (!title && !folder) throw new Error('Falta el nombre del proyecto');

  if (folder) {
    const dir = path.resolve(String(folder));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`La carpeta no existe: ${dir}`);
    if (!isPathAllowed(user, dir)) throw new Error('No tienes acceso a esa carpeta');
    return { dir, name: title || path.basename(dir), created: false, git: fs.existsSync(path.join(dir, '.git')) };
  }

  const root = projectsRoot(user, options);
  if (!root) throw new Error('No tienes ninguna carpeta donde crear proyectos');
  if (!isPathAllowed(user, root)) throw new Error('No tienes acceso a la carpeta de proyectos');
  fs.mkdirSync(root, { recursive: true });

  const dir = freeFolder(root, slugify(title));
  fs.mkdirSync(dir);
  const about = String(description || '').trim().slice(0, 2000);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${title}\n${about ? `\n${about}\n` : ''}`, 'utf-8');

  const result = { dir, name: title, created: true, git: false };
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    result.git = true;
    git(dir, ['add', 'README.md']);
    // Sin identidad de git configurada en el servidor, el commit va a nombre de Zer0Code
    let identity = [];
    try {
      git(dir, ['config', 'user.email']);
    } catch {
      identity = ['-c', 'user.name=Zer0Code', '-c', 'user.email=zer0code@localhost'];
    }
    git(dir, [...identity, 'commit', '-q', '-m', 'Primer commit']);
  } catch (err) {
    result.commitError = String(err.stderr || err.message || err).trim().split('\n')[0].slice(0, 300);
  }
  return result;
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);

/** ¿Es una herramienta de archivos que trabaja dentro de `dir`? (rutas absolutas; las relativas no cuentan) */
export function isProjectEdit(tool, input, dir) {
  if (!FILE_TOOLS.has(tool) || !dir) return false;
  const target = input?.file_path || input?.notebook_path || input?.path;
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Instrucciones para el modelo: cuándo crear el proyecto y mover la conversación */
export function projectToolHint(workspace) {
  return [
    'Zer0Code — proyectos: tienes la herramienta `create_project` (servidor MCP «zer0code»).',
    `Esta conversación trabaja ahora en: ${workspace || '(sin carpeta)'}.`,
    'Si el usuario te pide crear algo nuevo con varios archivos (una app, una web, un juego, una herramienta…) y esa carpeta no es un proyecto adecuado para ello (por ejemplo, una carpeta general como el home o Documentos, o un proyecto que no tiene nada que ver), llama a `create_project` ANTES de crear archivos: crea la carpeta del proyecto (con git y README) y mueve esta conversación allí.',
    'Después trabaja en la ruta que te devuelve: usa rutas absolutas y, en la terminal, entra antes con cd. No la uses si ya estás en el proyecto correcto, para cambios pequeños o si el usuario no quiere un proyecto aparte.'
  ].join('\n');
}
