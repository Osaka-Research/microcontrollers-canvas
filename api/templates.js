'use strict';
const { publishedTemplates } = require('./lib/catalog');

module.exports = async function templates(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; return res.end(); }
  const origin = req.headers.origin;
  const allowedOrigin = process.env.CANVAS_ORIGIN || '';
  if (origin && allowedOrigin && origin !== allowedOrigin) { res.statusCode = 403; return res.end(); }
  if (origin && (origin === allowedOrigin || !allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  try {
    const list = await publishedTemplates();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.end(JSON.stringify({ templates: list }));
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: error.message }));
  }
};
