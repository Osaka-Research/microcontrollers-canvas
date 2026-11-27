#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.research', 'adafruit');
const dbPath = path.join(dataDir, 'catalog.sqlite');
const reviewPath = path.join(dataDir, 'canvas-import-review.json');
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const sourcePath = path.join(dataDir, 'products-with-images.json');
const sourceProducts = JSON.parse(await readFile(sourcePath, 'utf8'));
const sourceById = new Map(sourceProducts.map(product => [String(product.product_id), product]));
await mkdir(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS adafruit_products (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    product_url TEXT NOT NULL,
    image_url TEXT,
    image_path TEXT,
    image_alt TEXT,
    candidate INTEGER NOT NULL CHECK (candidate IN (0, 1)),
    raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS component_catalog (
    id TEXT PRIMARY KEY CHECK (id <> 'board' AND length(id) BETWEEN 1 AND 60),
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    definition TEXT NOT NULL CHECK (json_valid(definition) AND json_extract(definition, '$.id') = id),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS component_catalog_published_category_idx
    ON component_catalog(category, id) WHERE status = 'published';
  CREATE INDEX IF NOT EXISTS adafruit_products_candidate_idx
    ON adafruit_products(candidate, product_id);
`);

const insertProduct = db.prepare(`
  INSERT INTO adafruit_products (product_id, name, product_url, image_url, image_path, image_alt, candidate, raw_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product_id) DO UPDATE SET
    name=excluded.name, product_url=excluded.product_url, image_url=excluded.image_url,
    image_path=excluded.image_path, image_alt=excluded.image_alt, candidate=excluded.candidate,
    raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);
const insertComponent = db.prepare(`
  INSERT INTO component_catalog (id, category, status, version, definition, updated_at)
  VALUES (?, ?, 'draft', 1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET category=excluded.category, definition=excluded.definition, updated_at=excluded.updated_at
`);

const now = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try {
  for (const product of review.products) {
    const source = sourceById.get(String(product.productId)) || {};
    const raw = {
      ...source,
      local_image: product.images?.local || null,
      canvas_id: product.id,
      canvas_category: product.candidateCategory,
      component_candidate: product.appearsToBeElectronicComponentCandidate
    };
    insertProduct.run(
      product.productId, product.name, product.productPage,
      product.images?.remote || null, product.images?.local || null,
      product.images?.alt || null, product.appearsToBeElectronicComponentCandidate ? 1 : 0,
      JSON.stringify(raw), now
    );
    if (product.definitionDraft) {
      const definition = {
        ...product.definitionDraft,
        sourceProductId: product.productId,
        productUrl: product.productPage,
        availability: product.availability,
        localImagePath: product.images?.local || null,
        needsPinoutResearch: true,
        enabled: false
      };
      insertComponent.run(product.id, product.candidateCategory, JSON.stringify(definition), now);
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

const counts = db.prepare(`
  SELECT (SELECT count(*) FROM adafruit_products) AS products,
         (SELECT count(*) FROM adafruit_products WHERE candidate = 1) AS candidates,
         (SELECT count(*) FROM component_catalog) AS staged_components,
         (SELECT count(*) FROM component_catalog WHERE status = 'published') AS published_components
`).get();
db.close();
console.log(JSON.stringify({ database: path.relative(root, dbPath), ...counts }, null, 2));
