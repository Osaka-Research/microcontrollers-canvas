import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const definitions = require('./initial-component-catalog.cjs');

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in your local environment.');

const rows = definitions.map(definition => ({
  id: definition.id,
  category: definition.category,
  status: 'published',
  version: 1,
  definition,
  updated_at: new Date().toISOString()
}));
const response = await fetch(`${url}/rest/v1/component_catalog?on_conflict=id`, {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows)
});
if (!response.ok) throw new Error(`Catalog seed failed (${response.status}): ${await response.text()}`);
console.log(`Published ${rows.length} component definitions.`);
