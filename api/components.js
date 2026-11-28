// @ts-check
'use strict';

const { createHash } = require('node:crypto');
const { publishedCatalog } = require('./lib/catalog');

/**
 * @param {any} req
 * @param {any} res
 */
module.exports = async function components(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; return res.end(); }
  const origin = req.headers?.origin;
  const allowedOrigin = process.env.CANVAS_ORIGIN || '';
  if (origin && allowedOrigin && origin !== allowedOrigin) { res.statusCode = 403; return res.end(); }
  if (origin && (origin === allowedOrigin || !allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  try {
    const definitions = await publishedCatalog();
    const payload = JSON.stringify({ definitions });
    const etag = `W/"${createHash('sha256').update(payload).digest('hex').slice(0, 24)}"`;
    const ifNoneMatch = req.headers?.['if-none-match'];
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').map(s => s.trim()).includes(etag)) {
      res.statusCode = 304;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(payload);
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
};
