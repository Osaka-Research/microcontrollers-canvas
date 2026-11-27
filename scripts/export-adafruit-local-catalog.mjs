#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.research', 'adafruit');
const db = new DatabaseSync(path.join(dataDir, 'catalog.sqlite'), { readOnly: true });
const rows = db.prepare(`
  SELECT id, category, status, version, definition, updated_at
  FROM component_catalog ORDER BY category, id
`).all().map(row => ({ ...row, definition: JSON.parse(row.definition) }));
db.close();

await mkdir(dataDir, { recursive: true });
const outputPath = path.join(dataDir, 'supabase-component-catalog-import.json');
await writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Exported ${rows.length} draft rows in the Supabase component_catalog shape to ${path.relative(root, outputPath)}.`);
