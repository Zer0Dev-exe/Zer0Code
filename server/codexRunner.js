import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { toolBinary } from './toolsManager.js';
import { activeProcesses, writeTempAttachments, removeTempDir, releaseProcess } from './claudeRunner.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Binario de Codex CLI (el del proyecto; si no está, el global)
 */
export function getCodexBinary() {
  return toolBinary('codex');
}

// Modos de la web -> sandbox de Codex (en `exec` no se puede preguntar, así que nunca pide aprobación)
const SANDBOX_MODES = {
  plan: 'read-only',
  manual: 'workspace-write',
  acceptEdits: 'workspace-write',
  auto: 'danger-full-access',
  bypassPermissions: 'danger-full-access'
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Ejecutar una tarea con Codex CLI (suscripción de ChatGPT). Emite los mismos eventos que el runner de Claude.
 * @param {boolean} [options.restricted] - Usuario con carpetas limitadas: nunca sale del sandbox del workspace
 */
export function executeCodexTask({
  prompt,
  workspace,
  sessionId,
  owner,
  permissionMode = 'acceptEdits',
  restricted = false,
  model,
  attachments,
  effort,
  onEvent,
  onDone,
  onError
}) {
  if (activeProcesses.has(owner)) {
    throw new Error('Ya tienes una tarea en ejecución. Cancélala primero.');
  }

  const targetDir = workspace && fs.existsSync(workspace) ? workspace : projectRoot;
  const temp = writeTempAttachments(attachments);
  const images = temp ? temp.files.filter(f => IMAGE_EXT.test(f)) : [];
  const others = temp ? temp.files.filter(f => !IMAGE_EXT.test(f)) : [];
  if (others.length) {
    prompt = `${prompt} [Archivos adjuntos por el usuario: ${others.join(' , ')}]`;
  }

  let sandbox = SANDBOX_MODES[permissionMode] || 'workspace-write';
  if (restricted && sandbox === 'danger-full-access') sandbox = 'workspace-write';

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--color', 'never',
    '-C', targetDir,
    '-s', sandbox,
    '-c', 'approval_policy="never"'
  ];
  if (sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=true');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (temp) args.push('--add-dir', temp.dir);
  images.forEach(img => args.push('-i', img));
  // El prompt va por stdin ('-'): sin límites de longitud ni problemas de comillas
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');

  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  onEvent({ type: 'system_start', taskId, model: model || 'codex', workspace: targetDir, timestamp: Date.now() });

  const isWin = process.platform === 'win32';
  const bin = getCodexBinary();
  const child = isWin
    ? spawn('cmd.exe', ['/c', bin, ...args], { cwd: targetDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(bin, args, { cwd: targetDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  activeProcesses.set(owner, child);
  child.stdin.end(prompt);

  let capturedSessionId = sessionId || null;
  let accumulatedText = '';
  let accumulatedStderr = '';
  let failure = null;
  let usage = null;
  const textSent = new Map(); // id del mensaje -> texto ya enviado (por si llega en varias actualizaciones)
  const toolsSent = new Set();

  const sendText = (item) => {
    const prev = textSent.get(item.id) ?? null;
    const full = String(item.text || '');
    if (prev === null && accumulatedText) {
      accumulatedText += '\n\n';
      onEvent({ type: 'text_delta', text: '\n\n', sessionId: capturedSessionId });
    }
    const delta = full.slice((prev || '').length);
    textSent.set(item.id, full);
    if (!delta) return;
    accumulatedText += delta;
    onEvent({ type: 'text_delta', text: delta, sessionId: capturedSessionId });
  };

  const toolFor = (item) => {
    switch (item.type) {
      case 'command_execution':
        return { tool: 'Bash', input: { command: item.command, description: item.command } };
      case 'file_change':
        return { tool: 'Edit', input: { file_path: (item.changes || []).map(c => c.path).join(', ') } };
      case 'web_search':
        return { tool: 'WebSearch', input: { query: item.query } };
      case 'mcp_tool_call':
        return { tool: `${item.server}.${item.tool}`, input: item.arguments || {} };
      case 'todo_list':
        return {
          tool: 'TodoWrite',
          input: { todos: (item.items || []).map(t => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) }
        };
      default:
        return null;
    }
  };

  const handleItem = (phase, item) => {
    if (!item) return;
    if (item.type === 'agent_message') return sendText(item);
    if (item.type === 'reasoning') {
      if (phase === 'item.completed' && item.text) onEvent({ type: 'thinking_delta', thinking: item.text + '\n\n', sessionId: capturedSessionId });
      return;
    }
    if (item.type === 'error') {
      accumulatedStderr += (accumulatedStderr ? '\n' : '') + (item.message || '');
      return;
    }
    const tool = toolFor(item);
    if (!tool) return;
    if (!toolsSent.has(item.id)) {
      toolsSent.add(item.id);
      onEvent({ type: 'tool_use', id: item.id, tool: tool.tool, input: tool.input, subagent: false, sessionId: capturedSessionId });
    }
    if (phase === 'item.completed') {
      const isError = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
      const content = item.aggregated_output ?? item.result?.content?.map?.(c => c.text || '').join('\n') ?? item.error?.message ?? '';
      onEvent({ type: 'tool_result', id: item.id, isError, content: String(content).slice(0, 2000), sessionId: capturedSessionId });
    }
  };

  let buffer = '';
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'thread.started' && event.thread_id) {
        capturedSessionId = event.thread_id;
      } else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        handleItem(event.type, event.item);
      } else if (event.type === 'turn.completed') {
        usage = event.usage || null;
      } else if (event.type === 'turn.failed') {
        failure = event.error?.message || 'Codex no pudo completar la tarea';
      } else if (event.type === 'error') {
        failure = event.message || 'Error de Codex';
      }
    }
  });

  child.stderr.on('data', (data) => {
    const str = data.toString().trim();
    if (str) accumulatedStderr += (accumulatedStderr ? '\n' : '') + str;
  });

  child.on('close', (code) => {
    releaseProcess(owner, child);
    removeTempDir(temp?.dir);
    if (code === 0 && !failure) {
      onEvent({ type: 'result', result: accumulatedText, usage, sessionId: capturedSessionId });
      onDone({ success: true, exitCode: code, sessionId: capturedSessionId, text: accumulatedText, result: usage ? { usage } : null });
    } else {
      onError({
        success: false,
        exitCode: code,
        sessionId: capturedSessionId,
        text: accumulatedText,
        stderr: accumulatedStderr,
        message: /401 Unauthorized|not logged in/i.test(`${failure} ${accumulatedStderr}`)
          ? 'ChatGPT no está conectado en el servidor: inicia sesión con `codex login --device-auth`.'
          : failure || lastLines(accumulatedStderr) || `Codex finalizó con código ${code}`
      });
    }
  });

  child.on('error', (err) => {
    releaseProcess(owner, child);
    removeTempDir(temp?.dir);
    onError({ success: false, message: err.message });
  });

  return { taskId, sessionId: capturedSessionId };
}

// Las últimas líneas del log de error (Codex escribe mucho en stderr)
function lastLines(text, n = 6) {
  return String(text || '').trim().split('\n').slice(-n).join('\n');
}
