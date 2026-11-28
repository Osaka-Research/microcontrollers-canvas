// @ts-check
'use strict';

/**
 * Validate Host and Origin headers for the local MCC development server
 * to block DNS rebinding and cross-site POST (CSRF) attacks while still
 * allowing normal top-level browser navigations to localhost/127.0.0.1.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * @param {string | undefined} hostHeader
 * @param {number} port
 */
function isAllowedLocalHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  let parsed;
  try {
    parsed = new URL(`http://${hostHeader.trim()}`);
  } catch {
    return false;
  }
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const effectivePort = parsed.port ? Number(parsed.port) : 80;
  return effectivePort === Number(port);
}

/**
 * @param {string | undefined} originHeader
 * @param {number} port
 */
function isAllowedLocalOrigin(originHeader, port) {
  if (typeof originHeader !== 'string' || !originHeader.trim()) return false;
  let parsed;
  try {
    parsed = new URL(originHeader.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const effectivePort = parsed.port ? Number(parsed.port) : 80;
  return effectivePort === Number(port);
}

/**
 * Check an incoming HTTP request against local Host/Origin rules.
 * @param {{ method?: string, headers?: Record<string, string | string[] | undefined>, pathname?: string }} req
 * @param {number} port
 * @returns {{ ok: boolean, status?: number, error?: string }}
 */
function checkLocalRequest(req, port) {
  const headers = req.headers || {};
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (!isAllowedLocalHost(host, port)) {
    return { ok: false, status: 403, error: 'Rejected request with disallowed Host header.' };
  }

  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (origin && !isAllowedLocalOrigin(origin, port)) {
    return { ok: false, status: 403, error: 'Cross-origin requests to the local MCC server are not allowed.' };
  }

  const method = String(req.method || 'GET').toUpperCase();
  const pathname = String(req.pathname || '');
  const fetchSite = Array.isArray(headers['sec-fetch-site']) ? headers['sec-fetch-site'][0] : headers['sec-fetch-site'];
  const fetchMode = Array.isArray(headers['sec-fetch-mode']) ? headers['sec-fetch-mode'][0] : headers['sec-fetch-mode'];

  // Allow normal top-level browser navigations (e.g., clicking a link or returning from OAuth),
  // while blocking cross-site API calls and state-changing requests.
  const isTopLevelNav = (method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/') && fetchMode === 'navigate';
  if (!isTopLevelNav && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    if (pathname.startsWith('/api/') || (method !== 'GET' && method !== 'HEAD')) {
      return { ok: false, status: 403, error: 'Cross-site requests to the local MCC server are not allowed.' };
    }
  }

  // Require an explicit matching local Origin on state-changing ChatGPT auth routes.
  if (method !== 'GET' && method !== 'HEAD' && pathname.startsWith('/api/chatgpt/')) {
    if (!origin || !isAllowedLocalOrigin(origin, port)) {
      return { ok: false, status: 403, error: 'A matching local Origin header is required for ChatGPT sign-in actions.' };
    }
  }

  return { ok: true };
}

module.exports = { isAllowedLocalHost, isAllowedLocalOrigin, checkLocalRequest };
