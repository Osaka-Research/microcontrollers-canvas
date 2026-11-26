'use strict';
const { randomUUID } = require('node:crypto');

const base = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Component catalog database is not configured.');
  return { url: url.replace(/\/$/, ''), key };
};

async function publishedCatalog() {
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
