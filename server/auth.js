import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';

const dataDir = DATA_DIR;
const credentialsPath = path.join(dataDir, 'auth.json');
const usersPath = path.join(dataDir, 'users.json');
const sessionsPath = path.join(dataDir, 'auth-sessions.json');

// Modos de ejecución que se pueden conceder a un usuario (el admin los tiene todos)
export const EXECUTION_MODES = ['manual', 'acceptEdits', 'plan', 'auto'];
const DEFAULT_USER_MODES = ['manual', 'acceptEdits', 'plan'];
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = 'zer0code';
const MIN_PASSWORD_LENGTH = 8;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // caducan tras 30 días sin uso
const SESSION_TOUCH_MS = 60 * 60 * 1000; // guardar el último uso como mucho una vez por hora

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.warn(`Error leyendo ${path.basename(file)}:`, err.message);
  }
  return fallback;
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error(`Error guardando ${path.basename(file)}:`, err.message);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const candidate = Buffer.from(hashPassword(password, stored.salt).hash, 'hex');
  const expected = Buffer.from(stored.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Comparación en tiempo constante de dos textos de cualquier longitud
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// --------------------------------------------------------------------------
// Credenciales: el .env solo siembra la contraseña inicial; después se guarda cifrada.
// Si cambias ZER0CODE_PASSWORD en el .env, esa pasa a ser la contraseña (sirve para recuperarla).
// --------------------------------------------------------------------------
let credentials = loadCredentials();

function envPassword() {
  return process.env.ZER0CODE_PASSWORD || DEFAULT_PASSWORD;
}

function loadCredentials() {
  const stored = readJson(credentialsPath, null);
  const envPass = envPassword();
  if (stored?.password && stored?.seed && verifyPassword(envPass, stored.seed)) {
    return stored;
  }
  // Primera ejecución o la contraseña del .env ha cambiado: sembrar desde el .env
  const seeded = {
    username: process.env.ZER0CODE_USER || DEFAULT_USER,
    password: hashPassword(envPass),
    seed: hashPassword(envPass),
    mustChangePassword: envPass === DEFAULT_PASSWORD || envPass.length < MIN_PASSWORD_LENGTH,
    updatedAt: Date.now()
  };
  writeJson(credentialsPath, seeded);
  return seeded;
}

export function getAdminUsername() {
  return credentials.username;
}

// Aviso de arranque: el admin aún tiene la contraseña por defecto
export function isUsingDefaultPassword() {
  return !!credentials.mustChangePassword;
}

// --------------------------------------------------------------------------
// Usuarios adicionales (los crea el admin). Cada uno tiene carpetas y modos permitidos
// y, opcionalmente, un límite de gasto mensual con la cuenta del anfitrión.
// --------------------------------------------------------------------------
let users = readJson(usersPath, {});

function saveUsers() {
  writeJson(usersPath, users);
}

function isAdminName(username) {
  return username === credentials.username;
}

// Datos que puede ver el resto del servidor (nunca el hash de la contraseña)
function publicUser(username) {
  if (isAdminName(username)) {
    return {
      username,
      role: 'admin',
      mustChangePassword: !!credentials.mustChangePassword,
      roots: [],
      allowedModes: [...EXECUTION_MODES],
      monthlyLimitUSD: null
    };
  }
  const u = users[username];
  if (!u) return null;
  return {
    username,
    role: 'user',
    mustChangePassword: !!u.mustChangePassword,
    roots: [...(u.roots || [])],
    allowedModes: [...(u.allowedModes || DEFAULT_USER_MODES)],
    monthlyLimitUSD: typeof u.monthlyLimitUSD === 'number' ? u.monthlyLimitUSD : null,
    createdAt: u.createdAt || null
  };
}

function passwordRecordFor(username) {
  if (isAdminName(username)) return credentials.password;
  return users[username]?.password || null;
}

function normalizeRoots(roots) {
  const list = (Array.isArray(roots) ? roots : String(roots || '').split(/\r?\n/))
    .map(r => String(r || '').trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error('Indica al menos una carpeta permitida');
  const resolved = [];
  for (const r of list) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`La carpeta no existe: ${abs}`);
    }
    if (!resolved.includes(abs)) resolved.push(abs);
  }
  return resolved;
}

function normalizeModes(modes) {
  const list = (Array.isArray(modes) ? modes : []).filter(m => EXECUTION_MODES.includes(m));
  if (list.length === 0) throw new Error('Permite al menos un modo de ejecución');
  return EXECUTION_MODES.filter(m => list.includes(m));
}

function normalizeLimit(limit) {
  if (limit === null || limit === undefined || limit === '') return null;
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 0) throw new Error('El límite mensual debe ser un número positivo');
  return Math.round(n * 100) / 100;
}

function validateNewPassword(password) {
  const pass = String(password ?? '');
  if (pass.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  return pass;
}

export function listUsers() {
  return [credentials.username, ...Object.keys(users).sort((a, b) => a.localeCompare(b))].map(publicUser);
}

export function createUser({ username, password, roots, allowedModes, monthlyLimitUSD }) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) {
    throw new Error('El usuario debe tener 3-32 caracteres: letras, números, punto, guion o guion bajo');
  }
  const taken = [credentials.username, ...Object.keys(users)].some(u => u.toLowerCase() === name.toLowerCase());
  if (taken) throw new Error('Ya existe un usuario con ese nombre');

  users[name] = {
    password: hashPassword(validateNewPassword(password)),
    // La contraseña la pone el admin: el usuario tendrá que cambiarla al entrar
    mustChangePassword: true,
    roots: normalizeRoots(roots),
    allowedModes: normalizeModes(allowedModes ?? DEFAULT_USER_MODES),
    monthlyLimitUSD: normalizeLimit(monthlyLimitUSD),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  saveUsers();
  return publicUser(name);
}

export function updateUser(username, { password, roots, allowedModes, monthlyLimitUSD }) {
  const u = users[username];
  if (!u) throw new Error(isAdminName(username) ? 'El administrador se configura desde el .env' : 'Usuario no encontrado');

  const next = { ...u };
  if (roots !== undefined) next.roots = normalizeRoots(roots);
  if (allowedModes !== undefined) next.allowedModes = normalizeModes(allowedModes);
  if (monthlyLimitUSD !== undefined) next.monthlyLimitUSD = normalizeLimit(monthlyLimitUSD);
  const resetPassword = password !== undefined && password !== null && password !== '';
  if (resetPassword) {
    next.password = hashPassword(validateNewPassword(password));
    next.mustChangePassword = true;
  }
  next.updatedAt = Date.now();
  users[username] = next;
  saveUsers();

  // Contraseña nueva: fuera de todos sus dispositivos
  if (resetPassword) logoutAll(username);
  return publicUser(username);
}

export function deleteUser(username) {
  if (!users[username]) return false;
  delete users[username];
  saveUsers();
  logoutAll(username);
  return true;
}

// --------------------------------------------------------------------------
// Sesiones persistentes (se guarda el hash del token, nunca el token)
// --------------------------------------------------------------------------
let sessions = readJson(sessionsPath, {});
pruneSessions();

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [key, s] of Object.entries(sessions)) {
    if (!s || now - (s.lastUsed || 0) > SESSION_TTL_MS) {
      delete sessions[key];
      changed = true;
    } else if (!s.username) {
      // Sesiones anteriores al soporte multiusuario: eran del admin
      s.username = credentials.username;
      changed = true;
    }
  }
  if (changed) writeJson(sessionsPath, sessions);
}

function createSessionToken(req, username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[hashToken(token)] = {
    username,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 200)
  };
  writeJson(sessionsPath, sessions);
  return token;
}

function getSessionFor(token) {
  if (!token) return null;
  const key = hashToken(token);
  const s = sessions[key];
  if (!s) return null;
  const now = Date.now();
  // Sesión caducada o de un usuario que ya no existe
  if (now - s.lastUsed > SESSION_TTL_MS || !publicUser(s.username)) {
    delete sessions[key];
    writeJson(sessionsPath, sessions);
    return null;
  }
  if (now - s.lastUsed > SESSION_TOUCH_MS) {
    s.lastUsed = now;
    writeJson(sessionsPath, sessions);
  }
  return s;
}

// --------------------------------------------------------------------------
// Límite de intentos por IP
// --------------------------------------------------------------------------
const failedLogins = new Map();
const MAX_TRACKED_IPS = 10000;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * IP real de quien intenta entrar. Detrás de un proxy en la misma máquina (cloudflared, Tailscale Serve,
 * nginx…) todas las peticiones llegan desde 127.0.0.1: sin esto, cinco fallos de cualquiera bloquearían
 * a todo el mundo.
 *
 * Solo se cree la ÚLTIMA entrada de X-Forwarded-For: es la que añade el proxy más cercano con la IP que
 * él ve (Cloudflare, Tailscale Serve, Caddy y nginx con proxy_add_x_forwarded_for). Las anteriores, igual
 * que CF-Connecting-IP o X-Real-IP, las puede traer el propio cliente (Tailscale Serve las deja pasar) y
 * servirían para esquivar el bloqueo o bloquear a otro. Y solo si la conexión viene de esta máquina.
 */
export function clientIp(req) {
  const peer = req?.socket?.remoteAddress || req?.ip || '';
  if (LOOPBACK_ADDRESSES.has(peer)) {
    const hops = String(req.headers?.['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    const nearest = hops.at(-1);
    if (nearest && /^[0-9a-fA-F:.]{2,45}$/.test(nearest)) return nearest;
  }
  return peer || 'desconocida';
}

function lockoutFor(ip) {
  const entry = failedLogins.get(ip);
  if (entry?.lockedUntil && Date.now() < entry.lockedUntil) return entry.lockedUntil;
  if (entry?.lockedUntil) failedLogins.delete(ip);
  return null;
}

function registerFailure(ip) {
  // Muchas IP distintas (ataque repartido): se olvidan las más antiguas para no crecer sin límite
  if (!failedLogins.has(ip) && failedLogins.size >= MAX_TRACKED_IPS) failedLogins.delete(failedLogins.keys().next().value);
  const entry = failedLogins.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_LOGINS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
    console.warn(`[seguridad] Demasiados intentos fallidos desde ${ip}: bloqueada 15 min`);
  }
  failedLogins.set(ip, entry);
  return entry;
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------
export function login(username, password, req) {
  const ip = clientIp(req);
  const lockedUntil = lockoutFor(ip);
  if (lockedUntil) {
    const minutes = Math.ceil((lockedUntil - Date.now()) / 60000);
    return { success: false, locked: true, message: `Demasiados intentos fallidos. Vuelve a probar en ${minutes} min.` };
  }

  const name = String(username ?? '');
  const knownName = [credentials.username, ...Object.keys(users)].find(u => safeEqual(name, u)) || null;
  // Con un usuario inexistente también se calcula un hash, para no delatar qué usuarios existen
  const stored = knownName ? passwordRecordFor(knownName) : credentials.password;
  const passOk = verifyPassword(password ?? '', stored);
  if (knownName && passOk) {
    failedLogins.delete(ip);
    const token = createSessionToken(req, knownName);
    const user = publicUser(knownName);
    return { success: true, token, username: knownName, role: user.role, mustChangePassword: user.mustChangePassword };
  }

  const entry = registerFailure(ip);
  const left = MAX_FAILED_LOGINS - entry.count;
  return {
    success: false,
    message: entry.lockedUntil
      ? 'Demasiados intentos fallidos. Vuelve a probar en 15 min.'
      : `Usuario o contraseña incorrectos${left <= 2 ? ` (te quedan ${left} intentos)` : ''}`
  };
}

export function changePassword(currentToken, currentPassword, newPassword) {
  const username = getSessionFor(currentToken)?.username;
  const stored = username ? passwordRecordFor(username) : null;
  if (!stored || !verifyPassword(currentPassword ?? '', stored)) {
    return { success: false, message: 'La contraseña actual no es correcta' };
  }
  const next = String(newPassword ?? '');
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { success: false, message: `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` };
  }
  if (next === DEFAULT_PASSWORD || verifyPassword(next, stored)) {
    return { success: false, message: 'Elige una contraseña distinta de la actual' };
  }

  if (isAdminName(username)) {
    credentials = { ...credentials, password: hashPassword(next), mustChangePassword: false, updatedAt: Date.now() };
    writeJson(credentialsPath, credentials);
  } else {
    users[username] = { ...users[username], password: hashPassword(next), mustChangePassword: false, updatedAt: Date.now() };
    saveUsers();
  }

  // Cerrar el resto de sesiones: quien tuviera la contraseña antigua deja de tener acceso
  logoutAll(username, currentToken);
  return { success: true };
}

export function validateToken(token) {
  return !!getSessionFor(token);
}

/**
 * Usuario dueño de un token (o null si la sesión no es válida)
 */
export function getUserFromToken(token) {
  const s = getSessionFor(token);
  return s ? publicUser(s.username) : null;
}

export function logout(token) {
  if (token) {
    delete sessions[hashToken(token)];
    writeJson(sessionsPath, sessions);
  }
  return { success: true };
}

/**
 * Cerrar todas las sesiones abiertas de un usuario (menos `exceptToken`, si se indica)
 */
export function logoutAll(username, exceptToken = null) {
  const keep = exceptToken ? hashToken(exceptToken) : null;
  for (const [key, s] of Object.entries(sessions)) {
    if (s.username === username && key !== keep) delete sessions[key];
  }
  writeJson(sessionsPath, sessions);
  return { success: true };
}

function tokenFromRequest(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

/**
 * Exige sesión válida. Mientras siga la contraseña por defecto solo se permite cambiarla.
 */
export function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  const user = getUserFromToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Acceso no autorizado. Inicia sesión.' });
  }
  req.userToken = token;
  req.user = user;
  if (user.mustChangePassword && !req.allowWithDefaultPassword) {
    return res.status(403).json({ success: false, mustChangePassword: true, error: 'Cambia la contraseña para continuar.' });
  }
  return next();
}

// Variante para las rutas que deben funcionar aunque haya que cambiar la contraseña
export function requireAuthAllowDefault(req, res, next) {
  req.allowWithDefaultPassword = true;
  return requireAuth(req, res, next);
}

// Solo el administrador (tras requireAuth)
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Solo el administrador puede hacer esto.' });
  }
  return next();
}

export { tokenFromRequest };
