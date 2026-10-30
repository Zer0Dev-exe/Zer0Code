import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { toolBinary } from './toolsManager.js';
import { activeProcesses, writeTempAttachments, removeTempDir, releaseProcess } from './claudeRunner.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Binario de Gemini CLI (el del proyecto; si no está, el global)
 */
export function getGeminiBinary() {
  return toolBinary('gemini');
}

// Modos de la web -> modo de aprobación de Gemini (sin terminal, lo que necesita aprobación se deniega)
const APPROVAL_MODES = {
  plan: 'plan',
  manual: 'default',
  acceptEdits: 'auto_edit',
  auto: 'yolo',
  bypassPermissions: 'yolo'
};

/**
 * Herramientas de Gemini -> nombre e input al estilo de Claude Code, para que la web las pinte igual
 */
function mapTool(name, p = {}) {
  switch (name) {
    case 'run_shell_command': return { tool: 'Bash', input: { command: p.command, description: p.description || p.command } };
    case 'read_file': return { tool: 'Read', input: { file_path: p.absolute_path || p.file_path || p.path } };
    case 'read_many_files': return { tool: 'Read', input: { file_path: [].concat(p.paths || p.include || []).join(', ') } };
    case 'write_file': return { tool: 'Write', input: { file_path: p.file_path || p.absolute_path, content: p.content } };
    case 'replace': return { tool: 'Edit', input: { file_path: p.file_path || p.absolute_path, old_string: p.old_string, new_string: p.new_string } };
    case 'glob': return { tool: 'Glob', input: { pattern: p.pattern } };
    case 'list_directory': return { tool: 'Glob', input: { pattern: p.dir_path || p.path } };
    case 'search_file_content':
    case 'grep_search':
    case 'grep': return { tool: 'Grep', input: { pattern: p.pattern } };
    case 'google_web_search': return { tool: 'WebSearch', input: { query: p.query } };
    case 'web_fetch': return { tool: 'WebFetch', input: { url: p.url || p.prompt } };
    case 'write_todos':
      return { tool: 'TodoWrite', input: { todos: (p.todos || []).map(t => ({ content: t.description, status: t.status })) } };
    default: return { tool: name, input: p };
  }
}

/**
 * Ejecutar una tarea con Gemini CLI (cuenta de Google / Google AI Pro). Emite los mismos eventos que el runner de Claude.
 * @param {boolean} [options.restricted] - Usuario con carpetas limitadas: nunca aprueba comandos sin preguntar
 */
export function executeGeminiTask({
  prompt,
  workspace,
  sessionId,
  owner,
  permissionMode = 'acceptEdits',
  restricted = false,
  model,
  attachments,
  onEvent,
  onDone,
  onError
}) {
  if (activeProcesses.has(owner)) {
    throw new Error('Ya tienes una tarea en ejecución. Cancélala primero.');
  }

  const targetDir = workspace && fs.existsSync(workspace) ? workspace : projectRoot;
  const temp = writeTempAttachments(attachments);
  if (temp) {
    // La sintaxis @ruta hace que Gemini lea los archivos (también imágenes)
    prompt = `${prompt}\n\nArchivos adjuntos por el usuario: ${temp.files.map(f => `@${f}`).join(' ')}`;
  }

  let approval = APPROVAL_MODES[permissionMode] || 'default';
  if (restricted && approval === 'yolo') approval = 'auto_edit';

  const args = ['-o', 'stream-json', '--skip-trust', '--approval-mode', approval];
  if (model) args.push('-m', model);
  if (temp) args.push('--include-directories', temp.dir);
  if (sessionId) args.push('--resume', sessionId);
  // El prompt va por stdin: -p '' activa el modo sin terminal y Gemini le añade lo que llega por stdin
  args.push('-p', '');

  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  onEvent({ type: 'system_start', taskId, model: model || 'gemini', workspace: targetDir, timestamp: Date.now() });

  const isWin = process.platform === 'win32';
  const bin = getGeminiBinary();
  const child = isWin
    ? spawn('cmd.exe', ['/c', bin, ...args], { cwd: targetDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(bin, args, { cwd: targetDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  activeProcesses.set(owner, child);
  child.stdin.end(prompt);

  let capturedSessionId = sessionId || null;
  let accumulatedText = '';
  let accumulatedStderr = '';
  let failure = null;
  let stats = null;
  let lastWasTool = false;

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

      if (event.type === 'init') {
        if (event.session_id) capturedSessionId = event.session_id;
      } else if (event.type === 'message' && event.role === 'assistant' && event.content) {
        // Texto nuevo tras herramientas: párrafo aparte
        if (lastWasTool && accumulatedText) {
          accumulatedText += '\n\n';
          onEvent({ type: 'text_delta', text: '\n\n', sessionId: capturedSessionId });
        }
        lastWasTool = false;
        accumulatedText += event.content;
        onEvent({ type: 'text_delta', text: event.content, sessionId: capturedSessionId });
      } else if (event.type === 'tool_use') {
        lastWasTool = true;
        const { tool, input } = mapTool(event.tool_name, event.parameters);
        onEvent({ type: 'tool_use', id: event.tool_id, tool, input, subagent: false, sessionId: capturedSessionId });
      } else if (event.type === 'tool_result') {
        const isError = event.status === 'error';
        const content = isError ? (event.error?.message || event.output || '') : (event.output || '');
        onEvent({ type: 'tool_result', id: event.tool_id, isError, content: String(content).slice(0, 2000), sessionId: capturedSessionId });
      } else if (event.type === 'error') {
        if (event.severity !== 'warning') failure = event.message || 'Error de Gemini';
      } else if (event.type === 'result') {
        stats = event.stats || null;
        if (event.status === 'error') failure = event.error?.message || failure || 'Gemini no pudo completar la tarea';
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
      onEvent({ type: 'result', result: accumulatedText, usage: stats, sessionId: capturedSessionId });
      onDone({
        success: true,
        exitCode: code,
        sessionId: capturedSessionId,
        text: accumulatedText,
        result: stats ? { ...(stats.duration_ms ? { duration_ms: stats.duration_ms } : {}), usage: stats } : null
      });
    } else {
      onError({
        success: false,
        exitCode: code,
        sessionId: capturedSessionId,
        text: accumulatedText,
        stderr: accumulatedStderr,
        message: code === 41 || /Manual authorization is required/.test(accumulatedStderr)
          ? 'Gemini no está conectado en el servidor: inicia sesión con tu cuenta de Google ejecutando `gemini` en una terminal.'
          : failure || String(accumulatedStderr).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n') || `Gemini finalizó con código ${code}`
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
