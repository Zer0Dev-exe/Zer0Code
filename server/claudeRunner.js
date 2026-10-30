import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { DATA_DIR } from './paths.js';
import { toolBinary } from './toolsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Detectar la ruta o comando del binario de Claude de forma multiplataforma (Windows / Linux / macOS)
 */
export function getClaudeBinary() {
  // La instalada desde Ajustes, la de node_modules (desarrollo, VPS) o la del sistema
  return toolBinary('claude');
}

/**
 * Mapear identificadores de modelo a los alias oficiales requeridos por Claude Code CLI ('sonnet', 'haiku', 'opus')
 */
export function mapModelToCli(model) {
  if (!model) return 'opus';
  const m = String(model).trim();
  const lower = m.toLowerCase();
  const legacySonnetIds = new Set([
    'claude-3-7-sonnet',
    'claude-3-7-sonnet-latest',
    'claude-3-7-sonnet-20250219'
  ]);
  if (legacySonnetIds.has(lower)) return 'sonnet';
  if (lower.startsWith('claude-')) return m;
  if (lower.includes('fable')) return 'claude-fable-5-1';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return m;
}

const clientConfigDir = path.join(DATA_DIR, '.client_claude_config');
if (!fs.existsSync(clientConfigDir)) {
  try {
    fs.mkdirSync(clientConfigDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

// Una tarea como máximo por usuario: usuario -> proceso de Claude Code
export const activeProcesses = new Map();

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Escribir los adjuntos en una carpeta temporal del sistema (se borra al terminar la tarea).
 * No se guardan en el workspace ni en el historial.
 */
export function writeTempAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Máximo ${MAX_ATTACHMENTS} archivos adjuntos por mensaje.`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0code-'));
  const files = [];
  try {
    attachments.forEach((att, i) => {
      const buf = Buffer.from(String(att.data || ''), 'base64');
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`"${att.name}" supera el límite de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
      }
      const safeName = String(att.name || `archivo-${i}`).replace(/[^\w.\-]/g, '_').slice(0, 100) || `archivo-${i}`;
      const filePath = path.join(dir, `${i}-${safeName}`);
      fs.writeFileSync(filePath, buf);
      files.push(filePath);
    });
  } catch (err) {
    removeTempDir(dir);
    throw err;
  }
  return { dir, files };
}

export function removeTempDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OUTPUT_STYLES = ['Explanatory', 'Learning'];

// Modos de la web -> valores de --permission-mode del CLI ('manual' es el modo por defecto, que pregunta)
const CLI_PERMISSION_MODES = {
  manual: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  bypassPermissions: 'bypassPermissions'
};

const PERMISSION_TOOL = 'mcp__zer0code__approve';
const permissionMcpScript = path.join(__dirname, 'permissionMcp.js');

export const tmpDir = path.join(DATA_DIR, '.tmp');
if (!fs.existsSync(tmpDir)) {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

/**
 * Archivo de settings con el estilo de respuesta elegido (null = estilo por defecto)
 */
function getOutputStyleSettingsFile(outputStyle) {
  if (!OUTPUT_STYLES.includes(outputStyle)) return null;
  const file = path.join(tmpDir, `output-style-${outputStyle.toLowerCase()}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ outputStyle }), 'utf-8');
  }
  return file;
}

/**
 * Borrar la transcripción que Claude Code guarda en disco para una sesión (usado por el modo incógnito)
 */
export function deleteClaudeTranscript(claudeSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(claudeSessionId || ''))) return 0;
  const configDirs = [
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    clientConfigDir
  ];
  let removed = 0;
  for (const dir of configDirs) {
    const projectsDir = path.join(dir, 'projects');
    if (!fs.existsSync(projectsDir)) continue;
    for (const project of fs.readdirSync(projectsDir)) {
      const base = path.join(projectsDir, project, claudeSessionId);
      for (const target of [`${base}.jsonl`, base]) {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Obtener el modo configurado en .env (Hoster o Client)
 */
export function getAppMode() {
  const mode = (process.env.MODE || 'Hoster').trim().toLowerCase();
  return mode === 'client' ? 'Client' : 'Hoster';
}

/**
 * Validar una clave API de Claude de forma aislada
 */
export function validateApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, message: 'La clave no puede estar vacía' };
  }
  const cleanKey = apiKey.trim();
  try {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: clientConfigDir,
      ANTHROPIC_API_KEY: cleanKey
    };
    const bin = getClaudeBinary();
    const cmd = `"${bin}" auth status`;
    const out = execSync(cmd, {
      encoding: 'utf-8',
      cwd: projectRoot,
      env,
      timeout: 10000
    });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const status = JSON.parse(jsonMatch[0]);
      if (status.loggedIn) {
        return { valid: true, status };
      }
    }
    return { valid: false, message: 'Clave no reconocida por Anthropic' };
  } catch (err) {
    return { valid: false, message: err.message || 'Error validando la clave' };
  }
}

// Get current Claude Auth status
export function getClaudeAuthStatus(clientApiKey = null) {
  const appMode = getAppMode();
  try {
    const env = { ...process.env };
    if (appMode === 'Client') {
      env.CLAUDE_CONFIG_DIR = clientConfigDir;
      if (clientApiKey && clientApiKey.trim()) {
        env.ANTHROPIC_API_KEY = clientApiKey.trim();
      } else {
        delete env.ANTHROPIC_API_KEY;
        return {
          loggedIn: false,
          mode: 'Client',
          needsKey: true,
          message: 'Se requiere configurar una API Key de Claude en Modo Cliente'
        };
      }
    } else {
      // Modo Hoster
      if (clientApiKey && clientApiKey.trim()) {
        env.ANTHROPIC_API_KEY = clientApiKey.trim();
      } else if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) {
        env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.trim();
      } else {
        delete env.ANTHROPIC_API_KEY;
      }
    }

    const bin = getClaudeBinary();
    const cmd = `"${bin}" auth status`;
    const out = execSync(cmd, {
      encoding: 'utf-8',
      cwd: projectRoot,
      env,
      timeout: 10000
    });
    // Parse JSON inside output
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    let parsed = null;
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = { raw: out, loggedIn: out.includes('"loggedIn": true') || out.includes('loggedIn: true') };
    }
    parsed.mode = appMode;
    return parsed;
  } catch (err) {
    return {
      loggedIn: false,
      mode: appMode,
      error: err.message
    };
  }
}

/**
 * Execute a task with Claude Code
 * @param {Object} options
 * @param {string} options.prompt - Prompt or command for Claude Code
 * @param {string} options.workspace - Working directory
 * @param {string} [options.sessionId] - Session ID to resume
 * @param {string} options.owner - Usuario que lanza la tarea (una tarea activa por usuario)
 * @param {string} [options.permissionMode] - 'manual' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
 * @param {{url: string, secret: string}} [options.permissionBridge] - Puente para pedir permisos desde la web
 * @param {string} [options.model] - Model name or alias
 * @param {string} [options.apiKey] - Claude API Key (requerida en Client mode, opcional en Hoster mode)
 * @param {Array<{name: string, data: string}>} [options.attachments] - Archivos adjuntos en base64 (temporales)
 * @param {string} [options.effort] - Nivel de esfuerzo: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 * @param {string} [options.outputStyle] - Estilo de respuesta: 'default' | 'Explanatory' | 'Learning'
 * @param {string} [options.customInstructions] - Instrucciones personalizadas que se añaden al system prompt
 * @param {function} options.onEvent - Callback for streaming events
 * @param {function} options.onDone - Callback when completed
 * @param {function} options.onError - Callback on error
 */
/** Nombre de la carpeta de Claude Code para un directorio de trabajo: /home/a/b.c -> -home-a-b-c */
export function claudeProjectSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Copia la sesión `sessionId` a la carpeta de proyecto de `cwd` si está en otra (la conversación se movió de
 * proyecto). Sin esto, --resume no la encuentra. Devuelve true si la ha copiado.
 */
export function ensureSessionInProject(configDir, sessionId, cwd) {
  try {
    if (!/^[\w-]+$/.test(sessionId)) return false;
    const projects = path.join(configDir, 'projects');
    const target = path.join(projects, claudeProjectSlug(cwd));
    const file = `${sessionId}.jsonl`;
    if (fs.existsSync(path.join(target, file)) || !fs.existsSync(projects)) return false;
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(projects, entry.name, file);
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(source, path.join(target, file));
      return true;
    }
  } catch (err) {
    console.warn('No se pudo trasladar la sesión de Claude:', err.message);
  }
  return false;
}

export function executeTask({
  prompt,
  workspace,
  sessionId,
  owner,
  permissionMode = 'auto',
  permissionBridge,
  model,
  apiKey,
  attachments,
  effort,
  outputStyle,
  customInstructions,
  onEvent,
  onDone,
  onError
}) {
  if (activeProcesses.has(owner)) {
    throw new Error('Ya tienes una tarea en ejecución con Claude Code. Cancélala primero.');
  }

  const appMode = getAppMode();
  const cleanEnv = { ...process.env };

  if (appMode === 'Client') {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('Modo Cliente activo: Debes configurar tu propia API Key de Claude en la configuración.');
    }
    cleanEnv.ANTHROPIC_API_KEY = apiKey.trim();
    // Aislamiento estricto de las credenciales del host
    cleanEnv.CLAUDE_CONFIG_DIR = clientConfigDir;
  } else {
    // Modo Hoster: si el cliente proporcionó su propia key la usa; si no, usa la cuenta/key del anfitrión
    if (apiKey && apiKey.trim()) {
      cleanEnv.ANTHROPIC_API_KEY = apiKey.trim();
    } else if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) {
      cleanEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.trim();
    } else {
      delete cleanEnv.ANTHROPIC_API_KEY;
    }
  }

  // Permitir modelos nuevos o dinámicos sin restricciones de catálogo rígidas
  cleanEnv.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';

  // Las peticiones de permiso esperan a que el usuario responda en la web (el CLI corta las llamadas MCP largas)
  if (permissionBridge && !cleanEnv.MCP_TOOL_TIMEOUT) {
    cleanEnv.MCP_TOOL_TIMEOUT = String(15 * 60 * 1000);
  }

  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const targetDir = workspace && fs.existsSync(workspace) ? workspace : projectRoot;

  const temp = writeTempAttachments(attachments);
  if (temp) {
    // En una sola línea: cmd.exe /c corta los argumentos con saltos de línea
    prompt = `${prompt} [Archivos adjuntos por el usuario (léelos con la herramienta Read): ${temp.files.join(' , ')}]`;
  }

  // Build arguments for Claude Code
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose'
  ];

  args.push('--permission-mode', CLI_PERMISSION_MODES[permissionMode] || 'default');

  // Cuando Claude Code necesita permiso lo pide a través del servidor MCP de Zer0Code (y este, a la web).
  // La configuración va en un archivo temporal porque lleva el secreto de la tarea.
  let mcpConfigPath = null;
  if (permissionBridge) {
    mcpConfigPath = path.join(tmpDir, `mcp-${taskId}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        zer0code: {
          type: 'stdio',
          command: process.execPath,
          args: [permissionMcpScript],
          env: {
            ZER0CODE_PERMISSION_URL: permissionBridge.url,
            ZER0CODE_PERMISSION_SECRET: permissionBridge.secret,
            // Herramientas de Zer0Code para el modelo (crear un proyecto y mover la conversación a él)
            ...(permissionBridge.actionUrl ? { ZER0CODE_ACTION_URL: permissionBridge.actionUrl } : {}),
            // Con la app de escritorio el servidor corre sobre el Node de Electron
            ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {})
          }
        }
      }
    }), { encoding: 'utf-8', mode: 0o600 });
    args.push('--mcp-config', mcpConfigPath, '--permission-prompt-tool', PERMISSION_TOOL);
    // Crear el proyecto no pide permiso: es la propia conversación organizándose
    if (permissionBridge.actionUrl) args.push('--allowedTools', 'mcp__zer0code__create_project');
  }

  // Set model using valid Claude Code CLI alias
  const cliModel = mapModelToCli(model);
  args.push('--model', cliModel);

  // Nivel de esfuerzo (solo valores admitidos por el CLI; sin flag = valor por defecto del modelo)
  if (effort && EFFORT_LEVELS.includes(effort)) {
    args.push('--effort', effort);
  }

  // Estilo de respuesta (se pasa como archivo de settings para evitar problemas de comillas en cmd.exe)
  const stylePath = getOutputStyleSettingsFile(outputStyle);
  if (stylePath) {
    args.push('--settings', stylePath);
  }

  // Instrucciones personalizadas (archivo temporal, se borra al terminar la tarea)
  let instructionsPath = null;
  if (customInstructions && customInstructions.trim()) {
    instructionsPath = path.join(tmpDir, `instructions-${taskId}.txt`);
    fs.writeFileSync(instructionsPath, customInstructions.trim().slice(0, 8000), 'utf-8');
    args.push('--append-system-prompt-file', instructionsPath);
  }

  // Resume previous session if provided
  if (sessionId) {
    // Claude guarda cada sesión en la carpeta de su proyecto: si la conversación cambió de carpeta, se copia
    ensureSessionInProject(cleanEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), sessionId, targetDir);
    args.push('--resume', sessionId);
  }

  // Permitir leer la carpeta temporal de adjuntos (está fuera del workspace)
  if (temp) {
    args.push('--add-dir', temp.dir);
  }

  onEvent({
    type: 'system_start',
    taskId,
    model: cliModel,
    workspace: targetDir,
    timestamp: Date.now()
  });

  let capturedSessionId = sessionId || null;
  let accumulatedText = '';
  let accumulatedStderr = '';
  let fullResult = null;
  let isFallback = false;

  // Multiplataforma: en Windows .cmd requiere cmd.exe /c
  // En Linux/macOS el binario se ejecuta directamente (manejado por el shebang de node)
  const isWin = process.platform === 'win32';
  const bin = getClaudeBinary();
  const child = isWin
    ? spawn('cmd.exe', ['/c', bin, ...args], {
        cwd: targetDir,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    : spawn(bin, args, {
        cwd: targetDir,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });

  activeProcesses.set(owner, child);

  let buffer = '';

  child.stdout.on('data', (data) => {
    const str = data.toString();
    buffer += str;

    const lines = buffer.split('\n');
    // Keep last incomplete segment in buffer
    buffer = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const event = JSON.parse(line);

        // Track session ID
        if (event.session_id) {
          capturedSessionId = event.session_id;
        }

        // Los eventos de subagentes (Task) llevan parent_tool_use_id: su texto no se mezcla con la respuesta principal
        const isSubagent = !!event.parent_tool_use_id;

        // Con --include-partial-messages los eventos de la API llegan envueltos en { type: 'stream_event', event }
        if (event.type === 'stream_event' && event.event) {
          const inner = event.event;
          if (isSubagent) continue;
          if (inner.type === 'content_block_start' && inner.content_block?.type === 'text' && accumulatedText) {
            // Nuevo bloque de texto tras herramientas o turnos previos: separar en párrafo nuevo
            accumulatedText += '\n\n';
            onEvent({ type: 'text_delta', text: '\n\n', sessionId: capturedSessionId });
          } else if (inner.type === 'content_block_delta' && inner.delta) {
            if (inner.delta.type === 'text_delta') {
              accumulatedText += inner.delta.text;
              onEvent({
                type: 'text_delta',
                text: inner.delta.text,
                sessionId: capturedSessionId
              });
            } else if (inner.delta.type === 'thinking_delta' && inner.delta.thinking) {
              onEvent({
                type: 'thinking_delta',
                thinking: inner.delta.thinking,
                sessionId: capturedSessionId
              });
            }
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          // Mensaje completo del asistente: aquí llegan las llamadas a herramientas con su input completo
          for (const block of event.message.content) {
            if (block.type !== 'tool_use') continue;
            onEvent({
              type: 'tool_use',
              id: block.id,
              tool: block.name,
              input: block.input,
              subagent: isSubagent,
              sessionId: capturedSessionId
            });
          }
        } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
          // Resultados de herramientas (devueltos por Claude Code como mensaje de usuario)
          for (const block of event.message.content) {
            if (block.type !== 'tool_result') continue;
            const content = Array.isArray(block.content)
              ? block.content.map(c => c.text || '').join('\n')
              : String(block.content || '');
            onEvent({
              type: 'tool_result',
              id: block.tool_use_id,
              isError: !!block.is_error,
              content: content.slice(0, 2000),
              sessionId: capturedSessionId
            });
          }
        } else if (event.type === 'result') {
          fullResult = event;
          if (event.result && !accumulatedText) {
            accumulatedText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
          }
          onEvent({
            type: 'result',
            result: event.result,
            cost: event.total_cost_usd,
            duration: event.duration_ms,
            usage: event.usage,
            sessionId: capturedSessionId
          });
        } else {
          // Other structured events (init, status, etc.)
          onEvent({
            type: 'event',
            subtype: event.subtype || event.type,
            data: event,
            sessionId: capturedSessionId
          });
        }
      } catch (e) {
        // Plain text output
        accumulatedText += line + '\n';
        onEvent({
          type: 'text_raw',
          text: line,
          sessionId: capturedSessionId
        });
      }
    }
  });

  child.stderr.on('data', (data) => {
    const errStr = data.toString().trim();
    if (!errStr) return;
    
    accumulatedStderr += (accumulatedStderr ? '\n' : '') + errStr;

    // Check if stream-json is not supported or needs fallback
    if (errStr.includes('Error: When using --print') && !isFallback) {
      console.warn('Fallback needed for claude command');
    }
    
    onEvent({
      type: 'stderr',
      text: errStr,
      sessionId: capturedSessionId
    });
  });

  const cleanupInstructions = () => {
    if (instructionsPath) fs.rm(instructionsPath, { force: true }, () => {});
    if (mcpConfigPath) fs.rm(mcpConfigPath, { force: true }, () => {});
  };
  child.once('close', cleanupInstructions);
  child.once('error', cleanupInstructions);

  child.on('close', (code) => {
    // Process any remaining text in buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        if (event.type === 'result') {
          fullResult = event;
          if (event.result) accumulatedText = event.result;
        }
      } catch (e) {
        accumulatedText += buffer;
      }
    }

    releaseProcess(owner, child);
    removeTempDir(temp?.dir);

    if (code === 0 || fullResult) {
      onDone({
        success: true,
        exitCode: code,
        sessionId: capturedSessionId,
        text: accumulatedText,
        result: fullResult
      });
    } else {
      const errorMsg = accumulatedStderr || accumulatedText || `El proceso de Claude Code finalizó con código ${code}`;
      onError({
        success: false,
        exitCode: code,
        sessionId: capturedSessionId,
        text: accumulatedText,
        stderr: accumulatedStderr,
        message: errorMsg
      });
    }
  });

  child.on('error', (err) => {
    releaseProcess(owner, child);
    removeTempDir(temp?.dir);
    onError({
      success: false,
      message: err.message
    });
  });

  return {
    taskId,
    sessionId: capturedSessionId
  };
}

// Liberar el hueco del usuario solo si sigue ocupado por este proceso (tras cancelar puede haber otro)
export function releaseProcess(owner, child) {
  if (activeProcesses.get(owner) === child) activeProcesses.delete(owner);
}

// Terminar un proceso y sus hijos
function killProcess(proc) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`);
    } catch (e) {
      try {
        proc.kill('SIGTERM');
      } catch (err) {}
    }
    return;
  }
  // Linux / macOS: terminar el subproceso y sus hijos
  try {
    execSync(`kill -TERM -${proc.pid} 2>/dev/null || kill -TERM ${proc.pid} 2>/dev/null`);
  } catch (e) {
    try {
      proc.kill('SIGTERM');
    } catch (err) {}
  }
}

// Los revisores del orquestador corren a la vez que la tarea principal, con su propia clave
export const REVIEW_KEY_SEP = '::review::';
export const reviewKey = (owner, chatId) => `${owner}${REVIEW_KEY_SEP}${chatId}`;

/**
 * Cancelar los revisores en marcha de un usuario (o solo los de una conversación)
 */
export function cancelReviewers(owner, chatId = null) {
  const prefix = chatId ? reviewKey(owner, chatId) : `${owner}${REVIEW_KEY_SEP}`;
  let canceled = 0;
  for (const [key, proc] of [...activeProcesses]) {
    if (key !== prefix && !(chatId === null && key.startsWith(prefix))) continue;
    killProcess(proc);
    activeProcesses.delete(key);
    canceled++;
  }
  return canceled;
}

/**
 * Cancelar la tarea activa de un usuario (y los revisores que la acompañan)
 */
export function cancelActiveTask(owner) {
  cancelReviewers(owner);
  const proc = activeProcesses.get(owner);
  if (proc) {
    killProcess(proc);
    activeProcesses.delete(owner);
    return { canceled: true };
  }
  return { canceled: false, message: 'No hay ninguna tarea activa' };
}

export function isTaskActive(owner) {
  return activeProcesses.has(owner);
}
