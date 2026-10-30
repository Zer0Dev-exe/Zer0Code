import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { slugify, createProject, projectsRoot, freeFolder, isProjectEdit } from '../server/projectCreator.js';
import { claudeProjectSlug, ensureSessionInProject } from '../server/claudeRunner.js';
import { registerTask, runTaskAction, unregisterTask } from '../server/permissionManager.js';

const admin = { username: 'admin', role: 'admin' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-projects-'));

test('proyectos: nombres de carpeta y carpeta de proyectos', () => {
  assert.equal(slugify('Mi App de Notas!'), 'mi-app-de-notas');
  assert.equal(slugify('Canción Ñandú'), 'cancion-nandu');
  assert.equal(slugify('***'), 'proyecto');
  assert.equal(projectsRoot(admin, { env: {}, home: '/h' }), path.join('/h', 'Projects'));
  assert.equal(projectsRoot(admin, { env: { ZER0CODE_PROJECTS_DIR: '/srv/p' } }), path.resolve('/srv/p'));
  const root = tmp();
  fs.mkdirSync(path.join(root, 'web'));
  assert.equal(freeFolder(root, 'web'), path.join(root, 'web-2'));
});

test('proyectos: crea la carpeta con git, README y primer commit', () => {
  const root = tmp();
  const p = createProject(admin, { name: 'Juego de la vida', description: 'Autómata celular' }, { env: { ZER0CODE_PROJECTS_DIR: root } });
  assert.equal(p.dir, path.join(root, 'juego-de-la-vida'));
  assert.equal(p.created, true);
  assert.match(fs.readFileSync(path.join(p.dir, 'README.md'), 'utf-8'), /# Juego de la vida\n\nAutómata celular/);
  assert.equal(p.git, true);
  assert.equal(p.commitError, undefined);
  // Mismo nombre otra vez: carpeta nueva, sin pisar la anterior
  const again = createProject(admin, { name: 'Juego de la vida' }, { env: { ZER0CODE_PROJECTS_DIR: root } });
  assert.equal(again.dir, path.join(root, 'juego-de-la-vida-2'));
});

test('proyectos: carpeta existente y usuarios restringidos', () => {
  const root = tmp();
  const existing = createProject(admin, { name: 'x', folder: root });
  assert.deepEqual([existing.dir, existing.created], [root, false]);
  assert.throws(() => createProject(admin, { name: 'x', folder: path.join(root, 'no-existe') }), /no existe/);
  const user = { username: 'ana', role: 'user', roots: [root] };
  const own = createProject(user, { name: 'Web' });
  assert.equal(path.dirname(own.dir), root);
  assert.throws(() => createProject(user, { name: 'x', folder: os.tmpdir() }), /No tienes acceso/);
  assert.throws(() => createProject(admin, {}), /Falta el nombre/);
});

test('proyectos: la sesión de Claude se copia a la carpeta nueva al reanudar', () => {
  const config = tmp();
  assert.equal(claudeProjectSlug('/home/a/.t3/projects/z'), '-home-a--t3-projects-z');
  const from = path.join(config, 'projects', claudeProjectSlug('/old'));
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'abc-123.jsonl'), '{"x":1}\n');
  assert.equal(ensureSessionInProject(config, 'abc-123', '/new/dir'), true);
  assert.equal(fs.readFileSync(path.join(config, 'projects', claudeProjectSlug('/new/dir'), 'abc-123.jsonl'), 'utf-8'), '{"x":1}\n');
  assert.equal(ensureSessionInProject(config, 'abc-123', '/new/dir'), false); // ya estaba
  assert.equal(ensureSessionInProject(config, '../etc', '/new/dir'), false);
});

test('proyectos: solo las tareas con acciones pueden crear proyectos', async () => {
  const withActions = registerTask({ owner: 'admin', chatId: 'c1', actions: { create_project: (a) => ({ dir: `/p/${a.name}` }) } });
  const reviewer = registerTask({ owner: 'admin', chatId: 'c1' });
  assert.deepEqual(await runTaskAction(withActions, 'create_project', { name: 'x' }), { ok: true, dir: '/p/x' });
  assert.equal((await runTaskAction(reviewer, 'create_project', { name: 'x' })).ok, false);
  assert.equal((await runTaskAction('nope', 'create_project', {})).ok, false);
  unregisterTask(withActions);
  unregisterTask(reviewer);
});

test('proyectos: el servidor MCP ofrece create_project y llama a Zer0Code', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ secret: req.headers['x-zer0code-secret'], body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, dir: '/p/notas', name: 'Notas', created: true, git: true }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/internal/action`;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'permissionMcp.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ZER0CODE_PERMISSION_URL: url, ZER0CODE_PERMISSION_SECRET: 's3', ZER0CODE_ACTION_URL: url } });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const ask = (msg) => new Promise((resolve) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    const wait = () => { const r = replies.find(x => x.id === msg.id); r ? resolve(r) : setTimeout(wait, 10); };
    wait();
  });
  const list = await ask({ id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(t => t.name), ['approve', 'create_project']);
  const call = await ask({ id: 2, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'Notas' } } });
  assert.match(call.result.content[0].text, /Proyecto «Notas» creado en \/p\/notas/);
  assert.deepEqual(calls[0], { secret: 's3', body: { action: 'create_project', args: { name: 'Notas' } } });
  child.kill();
  server.close();
});

test('proyectos: tras moverse, editar dentro del proyecto no pide permiso', () => {
  assert.equal(isProjectEdit('Write', { file_path: '/p/web/index.html' }, '/p/web'), true);
  assert.equal(isProjectEdit('Edit', { file_path: '/p/web/src/a.js' }, '/p/web'), true);
  assert.equal(isProjectEdit('Write', { file_path: '/p/web-2/a.js' }, '/p/web'), false);
  assert.equal(isProjectEdit('Write', { file_path: '/p/web/../secreto' }, '/p/web'), false);
  assert.equal(isProjectEdit('Write', { file_path: 'relativo.js' }, '/p/web'), false);
  assert.equal(isProjectEdit('Bash', { command: 'rm -rf /' }, '/p/web'), false);
  assert.equal(isProjectEdit('Write', { file_path: '/p/web/a' }, null), false);
});
