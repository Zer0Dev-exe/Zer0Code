// Servidor MCP mínimo (stdio, sin dependencias) que Claude Code usa como --permission-prompt-tool.
// Cuando el CLI necesita permiso para una herramienta, llama a `approve`; aquí se reenvía la petición
// al servidor de Zer0Code, que la muestra en la web y espera la respuesta del usuario.
// Con ZER0CODE_ACTION_URL también ofrece herramientas de Zer0Code al modelo, como `create_project`.
import http from 'http';
import readline from 'readline';

const CALLBACK_URL = process.env.ZER0CODE_PERMISSION_URL;
const SECRET = process.env.ZER0CODE_PERMISSION_SECRET;
const ACTION_URL = process.env.ZER0CODE_ACTION_URL;

const TOOL = {
  name: 'approve',
  description: 'Uso interno de Zer0Code: pide al usuario permiso para ejecutar una herramienta. No lo llames directamente.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' }
    },
    required: ['tool_name', 'input']
  }
};

const PROJECT_TOOL = {
  name: 'create_project',
  description: 'Crea un proyecto nuevo de Zer0Code y mueve esta conversación a él. Úsala cuando el usuario pida crear algo nuevo '
    + '(una app, una web, un juego…) y la conversación no esté ya en la carpeta de proyecto adecuada. Sin `folder` crea una '
    + 'carpeta nueva en la carpeta de proyectos con git, README.md y un primer commit; con `folder` usa esa carpeta existente. '
    + 'Devuelve la ruta del proyecto: a partir de ahí trabaja en ella con rutas absolutas (y cd en la terminal).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nombre corto y claro del proyecto, por ejemplo «App de notas»' },
      description: { type: 'string', description: 'Una o dos frases sobre el proyecto (va al README)' },
      folder: { type: 'string', description: 'Opcional: ruta absoluta de una carpeta existente que usar como proyecto' }
    },
    required: ['name']
  }
};

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-zer0code-secret': SECRET }
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Respuesta no válida del servidor de Zer0Code.')); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function createProject(args) {
  if (!ACTION_URL || !SECRET) throw new Error('Esta tarea no puede crear proyectos.');
  const result = await postJson(ACTION_URL, { action: 'create_project', args });
  if (!result?.ok) throw new Error(result?.error || 'No se pudo crear el proyecto.');
  return result;
}

// http en vez de fetch: la espera puede durar minutos y fetch corta a los 5 min sin cabeceras
function askServer(payload) {
  return new Promise((resolve) => {
    const deny = (message) => resolve({ behavior: 'deny', message });
    if (!CALLBACK_URL || !SECRET) return deny('Zer0Code no ha configurado el puente de permisos.');

    const body = JSON.stringify(payload);
    const req = http.request(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-zer0code-secret': SECRET
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const decision = JSON.parse(data);
          if (decision && (decision.behavior === 'allow' || decision.behavior === 'deny')) return resolve(decision);
        } catch {
          // respuesta no válida: se deniega abajo
        }
        deny('Respuesta no válida del servidor de Zer0Code.');
      });
    });
    req.on('error', (err) => deny(`No se pudo contactar con Zer0Code: ${err.message}`));
    req.end(body);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notificaciones

  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'zer0code', version: '1.0.0' }
        }
      });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: ACTION_URL ? [TOOL, PROJECT_TOOL] : [TOOL] } });
    case 'tools/call': {
      if (params?.name === PROJECT_TOOL.name && ACTION_URL) {
        try {
          const r = await createProject(params.arguments || {});
          const lines = [
            `Proyecto «${r.name}» ${r.created ? 'creado' : 'elegido'} en ${r.dir}. Esta conversación ya está en ese proyecto.`,
            r.created ? (r.git ? (r.commitError ? `Repositorio git creado, pero el primer commit falló: ${r.commitError}` : 'Tiene git (rama main), README.md y un primer commit.') : 'No se pudo iniciar git.') : null,
            `Trabaja a partir de ahora en ${r.dir}: usa rutas absolutas y, en la terminal, entra antes con cd "${r.dir}".`
          ].filter(Boolean);
          return send({ id, result: { content: [{ type: 'text', text: lines.join('\n') }] } });
        } catch (err) {
          return send({ id, result: { isError: true, content: [{ type: 'text', text: err.message }] } });
        }
      }
      if (params?.name !== TOOL.name) {
        return send({ id, error: { code: -32602, message: `Herramienta desconocida: ${params?.name}` } });
      }
      const args = params.arguments || {};
      const decision = await askServer({
        tool_name: args.tool_name,
        input: args.input || {},
        tool_use_id: args.tool_use_id || null
      });
      if (decision.behavior === 'allow' && !decision.updatedInput) decision.updatedInput = args.input || {};
      return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    }
    default:
      return send({ id, error: { code: -32601, message: `Método no soportado: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((err) => {
    if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: err.message } });
  });
});
rl.on('close', () => process.exit(0));
