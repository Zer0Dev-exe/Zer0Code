import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA_DIR } from './paths.js';

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let sessions = {};

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('Error reading sessions:', e.message);
  sessions = {};
}

// Las conversaciones incógnito solo viven en memoria: nunca se escriben en disco
function saveSessions() {
  try {
    const persistent = Object.fromEntries(Object.entries(sessions).filter(([, s]) => !s.incognito));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(persistent, null, 2));
  } catch (e) {
    console.error('Error saving sessions:', e.message);
  }
}

/**
 * Las conversaciones anteriores al soporte multiusuario pasan a ser del admin
 */
export function assignLegacyOwner(username) {
  let changed = false;
  for (const s of Object.values(sessions)) {
    if (!s.owner) {
      s.owner = username;
      changed = true;
    }
  }
  if (changed) saveSessions();
}

function lastAssistant(s) {
  for (let i = (s.messages || []).length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant') return { lastModel: m.model || null, lastProvider: m.provider || 'claude', lastStatus: m.status || null };
  }
  return {};
}

export function getAllSessions(owner) {
  return Object.values(sessions)
    .filter(s => !s.incognito && s.owner === owner)
    .map(s => ({
      id: s.id,
      title: s.title || 'Nueva conversación',
      workspace: s.workspace,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages ? s.messages.length : 0,
      // Con qué modelo se respondió por última vez (la app de escritorio lo enseña en la fila del hilo)
      ...lastAssistant(s)
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Conversación por id; con `owner` solo se devuelve si es suya
 */
export function getSession(id, owner) {
  const s = sessions[id];
  if (!s || (owner !== undefined && s.owner !== owner)) return null;
  return s;
}

export function createSession(title = 'Nueva conversación', workspace = '', { incognito = false, owner } = {}) {
  const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const now = Date.now();
  const newSession = {
    id,
    owner,
    title,
    workspace,
    claudeSessionId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...(incognito ? { incognito: true } : {})
  };
  sessions[id] = newSession;
  saveSessions();
  return newSession;
}

export function updateSessionTitle(id, title) {
  if (sessions[id]) {
    sessions[id].title = title;
    sessions[id].updatedAt = Date.now();
    saveSessions();
    return sessions[id];
  }
  return null;
}

/**
 * Pasar la conversación a otra carpeta (proyecto). Claude y ChatGPT pueden seguir con su sesión (la de Claude
 * se copia a la carpeta nueva al reanudar); las de Gemini y AGY dependen de la carpeta y se descartan: el
 * siguiente turno les pasa el historial del chat como contexto.
 */
export function moveSession(id, workspace) {
  const s = sessions[id];
  if (!s) return null;
  s.workspace = workspace;
  if (s.providerSessions) {
    const { gemini, agy, ...rest } = s.providerSessions;
    s.providerSessions = rest;
  }
  s.updatedAt = Date.now();
  saveSessions();
  return s;
}

export function setClaudeSessionId(id, claudeSessionId) {
  if (sessions[id]) {
    sessions[id].claudeSessionId = claudeSessionId;
    sessions[id].updatedAt = Date.now();
    saveSessions();
  }
}

/**
 * Id de sesión de un proveedor (Claude usa `claudeSessionId`; ChatGPT y Gemini, `providerSessions`)
 */
export function getProviderSessionId(session, provider) {
  if (!session) return null;
  return provider === 'claude' ? session.claudeSessionId : session.providerSessions?.[provider] || null;
}

export function setProviderSessionId(id, provider, value) {
  if (provider === 'claude') return setClaudeSessionId(id, value);
  if (sessions[id]) {
    sessions[id].providerSessions = { ...sessions[id].providerSessions, [provider]: value };
    sessions[id].updatedAt = Date.now();
    saveSessions();
  }
}

/**
 * Sesión propia del revisor en cada proveedor: así recuerda lo que ya señaló en rondas anteriores
 */
export function getReviewerSessionId(session, provider) {
  return session?.reviewerSessions?.[provider] || null;
}

export function setReviewerSessionId(id, provider, value) {
  if (!sessions[id] || !value) return;
  sessions[id].reviewerSessions = { ...sessions[id].reviewerSessions, [provider]: value };
  saveSessions();
}

export function addMessageToSession(id, message) {
  // La conversación pudo borrarse mientras el proveedor respondía: no tumbar el servidor
  if (!sessions[id]) return null;
  const s = sessions[id];
  s.messages.push(message);
  s.updatedAt = Date.now();

  // Auto-generate title from first user message if still default
  if (s.title === 'Nueva conversación' && message.role === 'user' && message.text) {
    const clean = message.text.trim().replace(/[\r\n]+/g, ' ');
    s.title = clean.length > 36 ? clean.slice(0, 36) + '...' : clean;
  }

  saveSessions();
  return s;
}

/**
 * Eliminar una conversación. Devuelve la sesión eliminada (o null si no existía)
 */
export function deleteSession(id) {
  const session = sessions[id];
  if (session) {
    delete sessions[id];
    saveSessions();
    return session;
  }
  return null;
}

/**
 * Eliminar todas las conversaciones de un usuario (al borrarlo). Devuelve las eliminadas.
 */
export function deleteSessionsByOwner(owner) {
  const removed = Object.values(sessions).filter(s => s.owner === owner);
  for (const s of removed) delete sessions[s.id];
  if (removed.length) saveSessions();
  return removed;
}
