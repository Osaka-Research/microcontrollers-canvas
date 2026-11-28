// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function supabaseBase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Projects database is not configured.');
  return { url: url.replace(/\/$/, ''), key };
}

/**
 * Verify a Supabase bearer token and return the authenticated user ID.
 * @param {any} req
 */
async function authenticateSupabaseUser(req) {
  const auth = req.headers?.authorization || '';
  const match = typeof auth === 'string' ? auth.match(/^Bearer\s+([^\s]+)$/i) : null;
  if (!match) return null;
  const { url, key } = supabaseBase();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${match[1]}` }
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && typeof user.id === 'string' && UUID_RE.test(user.id) ? user.id : null;
}

function ensureLocalProjectsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function parseProjectPayload(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a JSON project payload.' };
  const id = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : randomUUID();
  const project = body.project;
  if (!project || typeof project !== 'object' || !Array.isArray(project.nodes) || !Array.isArray(project.wires)) {
    return { error: 'Project must be an object containing nodes and wires arrays.' };
  }
  const serialized = JSON.stringify(project);
  if (serialized.length > MAX_PROJECT_BYTES) {
    return { error: 'Project exceeds the 4 MB storage limit.' };
  }
  const rawName = typeof body.name === 'string' ? body.name.trim() : typeof project.name === 'string' ? project.name.trim() : '';
  const name = (rawName || 'Untitled project').slice(0, 100);
  return { id, name, project, serialized };
}

/**
 * @param {any} req
 * @param {any} res
 */
module.exports = async function projects(req, res) {
  const origin = req.headers?.origin;
  const vercelHost = process.env.VERCEL_URL;
  const allowedOrigin = process.env.CANVAS_ORIGIN || (vercelHost ? `https://${vercelHost}` : '');
  const localOrigin = typeof origin === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  /** @type {Record<string, string>} */
  const cors = {};
  if (origin && allowedOrigin && origin !== allowedOrigin && !(localOrigin && !process.env.CANVAS_ORIGIN)) {
    return send(res, 403, { error: 'This site is not allowed to access saved projects.' });
  }
  if (origin && (origin === allowedOrigin || (localOrigin && !process.env.CANVAS_ORIGIN))) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    cors['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    cors.Vary = 'Origin';
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
    return res.end();
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return send(res, 405, { error: 'Method not allowed.' }, { ...cors, Allow: 'GET, POST, DELETE, OPTIONS' });
  }

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body;
  const parsedUrl = new URL(req.url || '/api/projects', 'http://localhost');
  const queryId = parsedUrl.searchParams.get('id');

  // Local SQLite mode (single-device local MCC server)
  if (process.env.LOCAL_COMPONENT_DB) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.LOCAL_COMPONENT_DB);
    try {
      ensureLocalProjectsTable(db);
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT id, name, project, created_at AS createdAt, updated_at AS updatedAt FROM user_projects ORDER BY updated_at DESC LIMIT 100').all();
        return send(res, 200, {
          storage: 'local-db',
          projects: rows.map(row => ({ ...row, project: JSON.parse(String(row.project)) }))
        }, cors);
      }
      if (req.method === 'POST') {
        const parsed = parseProjectPayload(body);
        if (parsed.error) return send(res, 400, { error: parsed.error }, cors);
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO user_projects (id, name, project, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, project = excluded.project, updated_at = excluded.updated_at
        `).run(parsed.id, parsed.name, parsed.serialized, now, now);
        return send(res, 200, {
          storage: 'local-db',
          project: { id: parsed.id, name: parsed.name, project: parsed.project, updatedAt: now }
        }, cors);
      }
      if (req.method === 'DELETE') {
        const id = queryId || body?.id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
          return send(res, 400, { error: 'Provide a valid project UUID to delete.' }, cors);
        }
        db.prepare('DELETE FROM user_projects WHERE id = ?').run(id);
        return send(res, 200, { deleted: true, id }, cors);
      }
    } catch (error) {
      return send(res, 503, { error: error instanceof Error ? error.message : 'Local project storage error.' }, cors);
    } finally {
      db.close();
    }
  }

  // Hosted Supabase mode (JWT-authenticated per-user cloud storage)
  try {
    const { url, key } = supabaseBase();
    const userId = await authenticateSupabaseUser(req);
    if (!userId) {
      return send(res, 401, { error: 'Sign in with a valid account token to sync cloud projects.' }, cors);
    }
    if (req.method === 'GET') {
      const response = await fetch(
        `${url}/rest/v1/user_projects?select=id,name,project,created_at,updated_at&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=100`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
      );
      if (!response.ok) return send(res, 503, { error: `Projects database request failed (${response.status}).` }, cors);
      const rows = await response.json();
      return send(res, 200, {
        storage: 'cloud',
        projects: Array.isArray(rows) ? rows.map(row => ({
          id: row.id, name: row.name, project: row.project, createdAt: row.created_at, updatedAt: row.updated_at
        })) : []
      }, cors);
    }
    if (req.method === 'POST') {
      const parsed = parseProjectPayload(body);
      if (parsed.error) return send(res, 400, { error: parsed.error }, cors);
      const now = new Date().toISOString();
      const response = await fetch(`${url}/rest/v1/user_projects?on_conflict=user_id,id`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([{ id: parsed.id, user_id: userId, name: parsed.name, project: parsed.project, updated_at: now }])
      });
      if (!response.ok) return send(res, 503, { error: `Could not save cloud project (${response.status}).` }, cors);
      return send(res, 200, {
        storage: 'cloud',
        project: { id: parsed.id, name: parsed.name, project: parsed.project, updatedAt: now }
      }, cors);
    }
    if (req.method === 'DELETE') {
      const id = queryId || body?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        return send(res, 400, { error: 'Provide a valid project UUID to delete.' }, cors);
      }
      const response = await fetch(
        `${url}/rest/v1/user_projects?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!response.ok) return send(res, 503, { error: `Could not delete cloud project (${response.status}).` }, cors);
      return send(res, 200, { deleted: true, id }, cors);
    }
  } catch (error) {
    return send(res, 503, { error: error instanceof Error ? error.message : 'Projects service unavailable.' }, cors);
  }
};
