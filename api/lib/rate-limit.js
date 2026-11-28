// @ts-check
'use strict';

const { createHash } = require('node:crypto');

/** @type {Map<string, number[]>} */
const buckets = new Map();
const MAX_BUCKETS = 4096;

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  return req.socket?.remoteAddress || 'unknown';
}

function keyFingerprint(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

/**
 * Sliding-window check for a single bucket key.
 * @param {string} bucketKey
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 */
function hitBucket(bucketKey, limit, windowMs, now) {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0 };
  const cutoff = now - windowMs;
  let timestamps = buckets.get(bucketKey);
  if (timestamps) {
    timestamps = timestamps.filter(ts => ts > cutoff);
  } else {
    timestamps = [];
  }
  if (timestamps.length >= limit) {
    buckets.set(bucketKey, timestamps);
    const oldest = timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  timestamps.push(now);
  buckets.set(bucketKey, timestamps);

  // Lazy pruning to keep memory bounded on long-lived servers.
  if (buckets.size > MAX_BUCKETS) {
    for (const [key, list] of buckets) {
      const fresh = list.filter(ts => ts > cutoff);
      if (fresh.length === 0) buckets.delete(key);
      else buckets.set(key, fresh);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Enforce per-IP and per-key rate limits for /api/build.
 * @param {any} req
 * @param {string} [apiKey]
 * @param {string} [action]
 */
function checkBuildRateLimit(req, apiKey, action = 'build') {
  const now = Date.now();
  const windowMs = Math.max(1000, Number(process.env.BUILD_RATE_LIMIT_WINDOW_MS || 60_000));
  const ipLimit = Number(process.env.BUILD_RATE_LIMIT_MAX ?? (action === 'check' ? 30 : 20));
  const keyLimit = Number(process.env.BUILD_KEY_RATE_LIMIT_MAX ?? (action === 'check' ? 30 : 20));

  const ip = clientIp(req);
  const ipResult = hitBucket(`ip:${action}:${ip}`, ipLimit, windowMs, now);
  if (!ipResult.allowed) return ipResult;

  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const keyResult = hitBucket(`key:${action}:${keyFingerprint(apiKey)}`, keyLimit, windowMs, now);
    if (!keyResult.allowed) return keyResult;
  }

  return { allowed: true, retryAfterSec: 0 };
}

function resetRateLimits() {
  buckets.clear();
}

module.exports = { checkBuildRateLimit, resetRateLimits, clientIp };
