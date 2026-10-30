import crypto from 'crypto';

// Peticiones de permiso de Claude Code a la espera de que el usuario responda desde la web
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

const tasks = new Map(); // secreto -> { owner, chatId, check, auto }
const pending = new Map(); // id -> petición pendiente
const alwaysAllowed = new Map(); // chatId -> Set de herramientas permitidas para toda la conversación

let notify = () => {};

/**
 * Función que reparte los avisos a la web: notify(username, mensaje)
 */
export function setPermissionNotifier(fn) {
  notify = fn;
}

/**
 * Registrar una tarea que puede pedir permisos. `check(tool, input)` devuelve un motivo
 * para denegar automáticamente (p. ej. ruta fuera de las carpetas permitidas) o null.
 * `auto(tool, input)` (opcional) decide sin preguntar al usuario: devuelve la decisión
 * ({ behavior: 'allow' | 'deny', ... }) o null para preguntar como siempre. Lo usa el revisor
 * del orquestador, que trabaja sin nadie delante y solo puede leer.
 */
export function registerTask({ owner, chatId, check = () => null, auto = null, actions = null }) {
  const secret = crypto.randomBytes(24).toString('hex');
  tasks.set(secret, { owner, chatId, check, auto, actions });
  return secret;
}

/**
 * Herramientas propias de Zer0Code (p. ej. crear un proyecto) llamadas desde el servidor MCP de la tarea.
 * Solo las tareas registradas con `actions` (el desarrollador, no el revisor) pueden usarlas.
 */
export async function runTaskAction(secret, name, args) {
  const task = tasks.get(secret);
  const action = task?.actions?.[name];
  if (!action) return { ok: false, error: 'Herramienta no disponible en esta tarea.' };
  try {
    return { ok: true, ...(await action(args && typeof args === 'object' ? args : {})) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * La tarea ha terminado: denegar lo que quede pendiente y olvidar el secreto
 */
export function unregisterTask(secret) {
  if (!tasks.has(secret)) return;
  tasks.delete(secret);
  for (const req of pending.values()) {
    if (req.secret === secret) settle(req, { behavior: 'deny', message: 'La tarea ha terminado.' }, false);
  }
}

export function forgetChat(chatId) {
  alwaysAllowed.delete(chatId);
}

function publicView(req) {
  return { id: req.id, sessionId: req.chatId, tool: req.tool, input: req.input, toolUseId: req.toolUseId, createdAt: req.createdAt };
}

function settle(req, decision, allowed) {
  if (!pending.has(req.id)) return;
  pending.delete(req.id);
  clearTimeout(req.timer);
  req.resolve(decision);
  notify(req.owner, { type: 'permission_resolved', id: req.id, sessionId: req.chatId, allowed });
}

/**
 * Petición del servidor MCP. Resuelve con la decisión en el formato de --permission-prompt-tool.
 */
export function requestPermission(secret, { tool_name, input, tool_use_id }) {
  const task = tasks.get(secret);
  if (!task) return Promise.resolve({ behavior: 'deny', message: 'Petición de permiso no reconocida.' });

  const tool = String(tool_name || 'Herramienta');
  const toolInput = input && typeof input === 'object' ? input : {};

  const blocked = task.check(tool, toolInput);
  if (blocked) return Promise.resolve({ behavior: 'deny', message: blocked });

  const automatic = task.auto ? task.auto(tool, toolInput) : null;
  if (automatic) return Promise.resolve(automatic.behavior === 'allow' ? { updatedInput: toolInput, ...automatic } : automatic);

  if (alwaysAllowed.get(task.chatId)?.has(tool)) {
    return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
  }

  return new Promise((resolve) => {
    const req = {
      id: 'perm_' + crypto.randomBytes(8).toString('hex'),
      secret,
      owner: task.owner,
      chatId: task.chatId,
      tool,
      input: toolInput,
      toolUseId: tool_use_id || null,
      createdAt: Date.now(),
      resolve
    };
    req.timer = setTimeout(() => {
      settle(req, { behavior: 'deny', message: 'Nadie respondió a la petición de permiso a tiempo.' }, false);
    }, PERMISSION_TIMEOUT_MS);
    pending.set(req.id, req);
    notify(req.owner, { type: 'permission_request', request: publicView(req) });
  });
}

/**
 * Respuesta del usuario desde la web. Solo el dueño de la tarea puede responder.
 */
export function answerPermission(id, username, { allow, always = false, message } = {}) {
  const req = pending.get(id);
  if (!req || req.owner !== username) return false;

  if (allow) {
    if (always) {
      if (!alwaysAllowed.has(req.chatId)) alwaysAllowed.set(req.chatId, new Set());
      alwaysAllowed.get(req.chatId).add(req.tool);
    }
    settle(req, { behavior: 'allow', updatedInput: req.input }, true);
  } else {
    const reason = String(message || '').trim().slice(0, 500);
    settle(req, { behavior: 'deny', message: reason || 'El usuario ha denegado el permiso.' }, false);
  }
  return true;
}

export function listPendingFor(username) {
  return [...pending.values()].filter(r => r.owner === username).map(publicView);
}
