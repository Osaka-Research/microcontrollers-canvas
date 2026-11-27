'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');

const base = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Component catalog database is not configured.');
  return { url: url.replace(/\/$/, ''), key };
};

function localDefinitions() {
  const dbPath = process.env.LOCAL_COMPONENT_DB;
  if (!dbPath) return null;
  const { DatabaseSync } = require('node:sqlite');
  const root = process.env.LOCAL_CATALOG_ROOT || process.cwd();
  const definitions = new Map();
  const legacyPath = require('node:path').join(root, '.research', 'local-catalog.json');
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    for (const definition of legacy) {
      if (definition && typeof definition.id === 'string' && Array.isArray(definition.pins)) {
        definitions.set(definition.id, definition);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT c.definition, p.raw_json FROM component_catalog c
      LEFT JOIN adafruit_products p ON p.product_id = json_extract(c.definition, '$.sourceProductId')
      WHERE c.status IN ('draft', 'published')
      AND json_array_length(json_extract(c.definition, '$.pins')) > 0
      AND json_extract(c.definition, '$.needsPinoutResearch') = 0`).all();
    for (const row of rows) {
      const definition = JSON.parse(row.definition);
      if (row.raw_json) {
        const product = JSON.parse(row.raw_json);
        definition.productDetails = {
          price: product.product_price || '',
          stock: product.product_stock || '',
          model: product.product_model || '',
          mpn: product.product_mpn || '',
          manufacturer: product.product_manufacturer || '',
          url: product.product_url || definition.productUrl || ''
        };
      }
      definition.enabled = true;
      definitions.set(definition.id, definition);
    }
  } finally {
    db.close();
  }

  const ready = [...definitions.values()].filter(definition =>
    definition && typeof definition.id === 'string' && definition.enabled !== false &&
    Array.isArray(definition.pins) && definition.pins.length > 0
  );
  for (const definition of ready) {
    const localPath = definition.localImagePath || definition.visual?.assetUrl || '';
    const match = String(localPath).match(/(?:images(?:-cropped)?\/)?(\d+)\.jpg$/);
    if (match) definition.visual = { ...(definition.visual || {}), assetUrl: `/local-assets/${match[1]}.jpg` };
  }
  return ready;
}

async function publishedCatalog() {
  const local = localDefinitions();
  if (local) {
    if (!local.length) throw new Error('No researched local components are available yet.');
    return local;
  }
  const { url, key } = base();
  const response = await fetch(`${url}/rest/v1/component_catalog?select=definition&status=eq.published&order=category.asc,id.asc`, {
    headers: { apikey: key, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Catalog database request failed (${response.status}).`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Catalog database returned invalid data.');
  const definitions = rows.map(row => row.definition).filter(def => def && typeof def.id === 'string' && typeof def.name === 'string' && Array.isArray(def.pins));
  if (!definitions.length) throw new Error('No published components are available.');
  const storageBase = `${url}/storage/v1/object/public/component-images/`;
  for (const def of definitions) if (def.assetPath && /^[a-zA-Z0-9/_-]+\.(png|jpe?g|webp|svg)$/i.test(def.assetPath)) {
    def.visual = { ...(def.visual || {}), assetUrl: storageBase + def.assetPath };
  }
  return definitions;
}

async function savePublishedCatalog(definitions) {
  if (process.env.LOCAL_COMPONENT_DB) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.LOCAL_COMPONENT_DB);
    const upsert = db.prepare(`INSERT INTO component_catalog (id, category, status, version, definition, updated_at)
      VALUES (?, ?, 'draft', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category, definition=excluded.definition, updated_at=excluded.updated_at`);
    const now = new Date().toISOString();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const source of definitions) {
        const definition = { ...source, enabled: false, needsPinoutResearch: true };
        upsert.run(definition.id, definition.category || 'OTHER ELECTRONICS', JSON.stringify(definition), now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
    }
    return;
  }
  const { url, key } = base();
  for (const definition of definitions) {
    const imageUrl = definition.visual?.imageUrl;
    if (typeof imageUrl !== 'string' || !imageUrl) continue;
    try {
      const parsed = new URL(imageUrl);
      // Operators opt in origins whose images they have permission to redistribute.
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
          parsed.origin !== process.env.COMPONENT_IMAGE_ORIGIN) continue;
      const image = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      const mime = image.headers.get('content-type')?.split(';')[0].toLowerCase();
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
      if (!image.ok || !extension) continue;
      const chunks = [];
      let size = 0;
      for await (const chunk of image.body) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { size = 0; break; }
        chunks.push(chunk);
      }
      if (!size) continue;
      const assetPath = `${definition.id}/${randomUUID()}.${extension}`;
      const upload = await fetch(`${url}/storage/v1/object/component-images/${assetPath}`, {
        method: 'POST', headers: { apikey: key, 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' }, body: Buffer.concat(chunks)
      });
      if (upload.ok) {
        definition.assetPath = assetPath;
        definition.visual = { ...definition.visual, imageUrl: '' };
      }
    } catch { /* Keep the verified source link and generic symbol when an image cannot be safely copied. */ }
  }
  const rows = definitions.map(definition => ({ id: definition.id, category: definition.category, status: 'published', version: 1, definition, updated_at: new Date().toISOString() }));
  const response = await fetch(`${url}/rest/v1/component_catalog?on_conflict=id`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error(`Could not save researched components (${response.status}).`);
}

module.exports = { publishedCatalog, savePublishedCatalog };
