#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chatgpt } from './chatgpt-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const dataDir = path.join(root, '.research', 'adafruit');
process.env.LOCAL_CATALOG_ROOT = root;
process.env.LOCAL_COMPONENT_DB ||= path.join(dataDir, 'catalog.sqlite');

const require = createRequire(import.meta.url);
const componentsHandler = require('../api/components.js');
const buildHandler = require('../api/build.js');
const { publishedCatalog } = require('../api/lib/catalog.js');
const { DatabaseSync } = require('node:sqlite');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function requestBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON.'); }
}

async function api(handler, req, res) {
  if (req.method === 'POST') {
    try { req.body = await requestBody(req); }
    catch (error) { return send(res, 400, { error: error.message }); }
  }
  try { await handler(req, res); }
  catch (error) { if (!res.headersSent) send(res, 500, { error: error.message }); else res.destroy(error); }
}

async function localImage(id, res) {
  if (!/^\d{1,8}\.jpg$/i.test(id)) return send(res, 404, { error: 'Image not found.' });
  const db = new DatabaseSync(process.env.LOCAL_COMPONENT_DB, { readOnly: true });
  let imagePath;
  try {
    imagePath = db.prepare('SELECT image_path FROM adafruit_products WHERE product_id = ?').get(id.slice(0, -4))?.image_path;
  } finally { db.close(); }
  if (!imagePath) return send(res, 404, { error: 'Image not found.' });
  const absolute = path.resolve(root, imagePath);
  if (!absolute.startsWith(dataDir + path.sep)) return send(res, 404, { error: 'Image not found.' });
  try { await access(absolute); }
  catch { return send(res, 404, { error: 'Image not found.' }); }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
  createReadStream(absolute).pipe(res);
}

async function staticFile(pathname, res) {
  let target;
  try { target = decodeURIComponent(pathname); }
  catch { return send(res, 400, 'Bad path', 'text/plain; charset=utf-8'); }
  if (target === '/') target = '/index.html';
  const absolute = path.resolve(dist, `.${target}`);
  if (!absolute.startsWith(dist + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  let fileStat;
  try { fileStat = await stat(absolute); }
  catch { return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  if (!fileStat.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  res.writeHead(200, { 'Content-Type': mime[path.extname(absolute).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(absolute).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/components') return api(componentsHandler, req, res);
  if (url.pathname === '/api/build') { req.chatgpt = chatgpt; return api(buildHandler, req, res); }
  if (url.pathname === '/api/chatgpt/session' && req.method === 'GET') {
    try { return send(res, 200, { session: await chatgpt.getSession(), localOnly: true }); }
    catch { return send(res, 503, { error: 'ChatGPT sign-in is unavailable on this device.' }); }
  }
  if (url.pathname === '/api/chatgpt/models' && req.method === 'GET') {
    try {
      const session = await chatgpt.getSession();
      if (!session.sharing) return send(res, 401, { error: 'Connect ChatGPT and allow plan usage first.' });
      return send(res, 200, { models: await chatgpt.listModels() });
    } catch { return send(res, 502, { error: 'Could not load models for this ChatGPT account.' }); }
  }
  if (url.pathname === '/api/chatgpt/sign-in' && req.method === 'POST') {
    try {
      const session = await chatgpt.signIn();
      return send(res, session.sharing ? 200 : 403, { session, error: session.sharing ? undefined : 'Enable ChatGPT plan usage in the sign-in consent screen to use this account here.' });
    } catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : 'ChatGPT sign-in did not complete.' }); }
  }
  if (url.pathname === '/api/chatgpt/disconnect' && req.method === 'POST') {
    try { await chatgpt.disconnect(); return send(res, 200, { session: await chatgpt.getSession() }); }
    catch { return send(res, 502, { error: 'Could not disconnect this ChatGPT account.' }); }
  }
  if (url.pathname === '/local-assets/' + path.basename(url.pathname)) return localImage(path.basename(url.pathname), res);
  if (url.pathname === '/healthz') {
    try {
      const db = new DatabaseSync(process.env.LOCAL_COMPONENT_DB, { readOnly: true });
      const counts = db.prepare(`SELECT count(*) AS products,
        sum(candidate) AS candidates FROM adafruit_products`).get();
      const researched = db.prepare(`SELECT count(*) AS researched FROM component_catalog
        WHERE json_array_length(json_extract(definition, '$.pins')) > 0
        AND json_extract(definition, '$.needsPinoutResearch') = 0`).get();
      db.close();
      const definitions = await publishedCatalog();
      let activeResearch = null;
      try { activeResearch = JSON.parse(await readFile(path.join(dataDir, 'codex-progress.json'), 'utf8')); } catch {}
      return send(res, 200, { status: 'ok', ...counts, researched: researched.researched, canvasCatalog: definitions.length, activeResearch, refreshSeconds: 15 });
    } catch (error) { return send(res, 503, { status: 'error', error: error.message }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  return staticFile(url.pathname, res);
});

server.listen(port, host, () => {
  console.log(`Microcontrollers Canvas local server: http://${host}:${port}`);
  console.log(`Local catalog API: http://${host}:${port}/api/components`);
  console.log(`Catalog status: http://${host}:${port}/healthz`);
  console.log('Local Adafruit photos are served only to this device; nothing is uploaded.');
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
