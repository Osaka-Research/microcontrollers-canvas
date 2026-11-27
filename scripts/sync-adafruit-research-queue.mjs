#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(root, '.research', 'adafruit');
const batchPath = path.join(archive, 'pinout-research', 'batch-001.json');
const queuePath = path.join(archive, 'pin-map-queue.json');
const batch = JSON.parse(await readFile(batchPath, 'utf8'));
const queue = JSON.parse(await readFile(queuePath, 'utf8'));
const byId = new Map(queue.map(item => [String(item.adafruitProductId), item]));
let updated = 0;

for (const record of batch.records) {
  const item = byId.get(String(record.productId));
  if (!item) continue;
  if (record.status === 'verified' && record.physicalPins.length > 0) {
    item.pinMapStatus = 'compatible';
    item.pins = record.physicalPins;
    item.sources = record.sources;
    item.reviewReason = 'Pinout researched and staged in local SQLite as an unpublished draft.';
  } else {
    item.pinMapStatus = 'manual_review';
    item.pins = [];
    item.sources = record.sources;
    item.reviewReason = record.gap || 'Physical pin layout remains incomplete; kept out of the canvas catalog.';
  }
  updated++;
}

const tempPath = `${queuePath}.tmp`;
await writeFile(tempPath, `${JSON.stringify(queue, null, 2)}\n`);
await import('node:fs/promises').then(({ rename }) => rename(tempPath, queuePath));
console.log(`Synchronized ${updated} pinout research results into the resumable queue.`);
