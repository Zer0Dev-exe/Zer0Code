import { spawn } from 'node:child_process';

// Use the same public protocol as Codex clients, including older CLI versions
// that do not implement `debug models`.
export function readCodexCatalog(binary, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      shell: process.platform === 'win32'
    });
    let buffer = '';
    let done = false;
    let id = 1;
    const models = [];
    const cursors = new Set();
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Codex model/list timed out')), timeout);
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    const list = (cursor = null) => send({ id: ++id, method: 'model/list', params: { limit: 100, cursor } });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('exit', () => finish(new Error('Codex exited before returning its models')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) return finish(new Error('Codex catalog exceeds size limit'));
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) return finish(new Error(message.error.message || 'Codex catalog request failed'));
        if (id === 1) {
          send({ method: 'initialized', params: {} });
          list();
          continue;
        }
        if (!Array.isArray(message.result?.data)) return finish(new Error('Invalid Codex catalog'));
        for (const m of message.result.data) {
          if (m.hidden || !m.model || models.some(item => item.slug === m.model)) continue;
          models.push({ slug: m.model, display_name: m.displayName || m.model,
            description: m.description, supported_reasoning_levels: m.supportedReasoningEfforts || [],
            isDefault: m.isDefault === true });
        }
        const cursor = message.result.nextCursor;
        if (cursor) {
          if (cursors.has(cursor)) return finish(new Error('Repeated Codex catalog cursor'));
          cursors.add(cursor);
          list(cursor);
        } else {
          finish(models.length ? null : new Error('Codex returned no visible models'));
        }
      }
    });
    send({ id, method: 'initialize', params: { clientInfo: { name: 'zer0code', version: '1.6.1' } } });
  });
}
