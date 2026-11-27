#!/usr/bin/env node
/**
 * Gemini Vision Photo Auditor & Cropper Worker for Microcontrollers Canvas.
 * Inspects every ready component photo in .research/adafruit/catalog.sqlite to ensure
 * ONLY the target component is visible (no hands, breadboards, other chips, USB cables,
 * loose header strips, coins, or multi-pack piles). Replaces dirty hero/video shots
 * with clean studio angles from Adafruit's CDN or crops tightly to the single component
 * using Python Pillow (backing up originals to .research/adafruit/images-originals/).
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE = path.join(ROOT, '.research', 'adafruit');
export const DEFAULT_DB = path.join(ARCHIVE, 'catalog.sqlite');
export const BACKUP_DIR = path.join(ARCHIVE, 'images-originals');
export const DEFAULT_MODEL = 'gemini-4-neon-medium';

export const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    clean: { type: 'boolean' },
    reason: { type: 'string' },
    needsAlternateAngle: { type: 'boolean' },
    cropBox: {
      type: 'array',
      items: { type: 'number' }
    }
  },
  required: ['clean', 'reason', 'needsAlternateAngle', 'cropBox']
};

export const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bestIndex: { type: 'integer' },
    clean: { type: 'boolean' },
    reason: { type: 'string' },
    cropBox: {
      type: 'array',
      items: { type: 'number' }
    }
  },
  required: ['bestIndex', 'clean', 'reason', 'cropBox']
};

export function candidateIndicesFor(imageUrl) {
  const match = String(imageUrl || '').match(/-(\d{2})\.jpg/i);
  const center = match ? Number(match[1]) : 0;
  const set = new Set();
  for (const offset of [-3, -2, -1, 1, 2, -4, 3]) {
    const idx = center + offset;
    if (idx >= 0 && idx <= 25) set.add(String(idx).padStart(2, '0'));
  }
  for (const fallback of ['00', '01', '02', '03', '06', '07']) set.add(fallback);
  return [...set].slice(0, 8);
}

export function validCropBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return false;
  const [x1, y1, x2, y2] = box;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return false;
  return x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= 1 && (x2 - x1) >= 0.12 && (y2 - y1) >= 0.12 && ((x2 - x1) < 0.98 || (y2 - y1) < 0.98);
}

export async function cropImageWithPillow(srcPath, destPath, cropBox) {
  if (!validCropBox(cropBox)) throw new Error(`Invalid crop box: ${JSON.stringify(cropBox)}`);
  const [x1, y1, x2, y2] = cropBox;
  const script = `
import sys
from PIL import Image
src, dst, x1, y1, x2, y2 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
img = Image.open(src).convert("RGB")
w, h = img.size
pad_x = (x2 - x1) * 0.04
pad_y = (y2 - y1) * 0.04
left = max(0, int(round((x1 - pad_x) * w)))
top = max(0, int(round((y1 - pad_y) * h)))
right = min(w, int(round((x2 + pad_x) * w)))
bottom = min(h, int(round((y2 + pad_y) * h)))
if right - left < 32 or bottom - top < 32:
    raise SystemExit("Crop too small")
img.crop((left, top, right, bottom)).save(dst, "JPEG", quality=92, optimize=True)
`;
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, srcPath, destPath, String(x1), String(y1), String(x2), String(y2)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr.on('data', c => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `Pillow crop exited ${code}`)));
  });
}

export function parseAgyJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const env = JSON.parse(lines[i]);
      if (env.structured_output && typeof env.structured_output === 'object') return env.structured_output;
      if (typeof env.response === 'string' && env.response.trim()) {
        const m = env.response.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      }
    } catch {}
  }
  throw new Error('Gemini vision output did not contain valid JSON.');
}

async function runAgyVision({ prompt, schema, model = DEFAULT_MODEL, agyBin = 'agy', timeoutMs = 90_000, rootDir = ROOT }) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'mcc-photo-'));
  const schemaPath = path.join(workDir, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  const args = [
    '--model', model,
    '--sandbox',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--output-format', 'json',
    '--json-schema', schemaPath,
    '--print-timeout', `${Math.max(30, Math.round(timeoutMs / 1000))}s`,
    '-p', prompt
  ];
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(agyBin, args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Gemini vision timed out')); }, timeoutMs + 15_000);
      child.stdout.on('data', c => { out += c.toString(); });
      child.stderr.on('data', c => { err = (err + c.toString()).slice(-1000); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`agy exited ${code}${err ? `: ${err.trim()}` : ''}`));
      });
    });
    return parseAgyJson(stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function fetchAlternateCandidates(productId, imageUrl, tempDir, fetchImpl = globalThis.fetch) {
  const found = [];
  for (const idx of candidateIndicesFor(imageUrl)) {
    if (found.length >= 4) break;
    const url = `https://cdn-shop.adafruit.com/970x728/${productId}-${idx}.jpg`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok || !res.headers.get('content-type')?.includes('image')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000) continue;
      const filePath = path.join(tempDir, `${productId}-${idx}.jpg`);
      writeFileSync(filePath, buf);
      found.push({ idx, url, filePath });
    } catch {}
  }
  return found;
}

export function getPhotoAuditStats(db) {
  const rows = db.prepare(`
    SELECT definition FROM component_catalog
    WHERE status IN ('draft', 'published')
      AND json_array_length(json_extract(definition, '$.pins')) > 0
      AND json_extract(definition, '$.needsPinoutResearch') = 0
  `).all();
  let audited = 0, clean = 0, replaced = 0, cropped = 0, pending = 0;
  for (const row of rows) {
    const def = JSON.parse(row.definition);
    const audit = def.photoAudit;
    if (!audit) { pending++; continue; }
    audited++;
    if (audit.clean) clean++;
    if (audit.action === 'replaced' || audit.action === 'replaced_and_cropped') replaced++;
    if (audit.action === 'cropped' || audit.action === 'replaced_and_cropped') cropped++;
  }
  return { totalReady: rows.length, audited, clean, replaced, cropped, pending };
}

function acquireLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const existingPid = Number(readFileSync(lockPath, 'utf8').trim());
      if (existingPid && existingPid !== process.pid) {
        process.kill(existingPid, 0);
        throw new Error(`Another photo audit worker is running (PID ${existingPid}).`);
      }
    } catch (error) {
      if (error.code !== 'ESRCH' && /already running|is running/.test(error.message)) throw error;
      try { unlinkSync(lockPath); } catch {}
    }
  }
  const fd = openSync(lockPath, 'wx');
  writeFileSync(fd, `${process.pid}\n`);
  closeSync(fd);
  return () => { try { rmSync(lockPath, { force: true }); } catch {} };
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function runPhotoAuditWorker(options = {}) {
  const {
    dbPath = DEFAULT_DB,
    rootDir = ROOT,
    backupDir = BACKUP_DIR,
    model = DEFAULT_MODEL,
    agyBin = 'agy',
    limit = 0,
    delayMs = 1500,
    timeoutMs = 90_000,
    componentId = null,
    force = false,
    auditor = null,
    picker = null,
    fetchImpl = globalThis.fetch,
    signal = null,
    log = console.log
  } = options;

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  mkdirSync(backupDir, { recursive: true });

  try {
    // Prioritize components currently used in ready templates first!
    const templateUsed = new Set();
    try {
      for (const r of db.prepare("SELECT project FROM project_templates WHERE status = 'ready'").all()) {
        for (const n of JSON.parse(r.project).nodes || []) templateUsed.add(n.type);
      }
    } catch {}

    const rows = db.prepare(`
      SELECT c.id, c.definition, p.product_id, p.image_path, p.image_url
      FROM component_catalog c
      LEFT JOIN adafruit_products p ON p.product_id = json_extract(c.definition, '$.sourceProductId')
      WHERE c.status IN ('draft', 'published')
        AND json_array_length(json_extract(c.definition, '$.pins')) > 0
        AND json_extract(c.definition, '$.needsPinoutResearch') = 0
        AND (? IS NULL OR c.id = ?)
    `).all(componentId, componentId);

    const queue = rows
      .map(row => ({ row, def: JSON.parse(row.definition) }))
      .filter(({ def }) => def.enabled !== false && (force || !def.photoAudit))
      .sort((a, b) => {
        const ta = templateUsed.has(a.row.id) ? 0 : 1;
        const tb = templateUsed.has(b.row.id) ? 0 : 1;
        if (ta !== tb) return ta - tb;
        return Number(b.row.product_id || 0) - Number(a.row.product_id || 0);
      });

    const stats = { processed: 0, kept: 0, replaced: 0, cropped: 0, errors: 0 };
    if (!queue.length) {
      log('All ready component photos are already audited.');
      return stats;
    }

    const doAudit = auditor || (async (def, photoPath) => runAgyVision({
      model, agyBin, timeoutMs, rootDir, schema: AUDIT_SCHEMA,
      prompt: `Inspect the component photo at ${photoPath} using read_file ONCE.
Target component: "${def.name}" (ID: ${def.id}).
Rule: ONLY this single target component should be in the photo — NO hands, NO breadboards, NO other boards/microcontrollers/chips, NO USB cables, NO separate batteries, NO coins/quarters, NO loose unattached header strips, NO multi-pack pile of 25 items.
- Set clean=true ONLY if the photo cleanly shows just this component (attached wires/leads that belong to the component itself are fine).
- If extra objects are present and there is likely a cleaner solo photo among Adafruit's other product angles, set needsAlternateAngle=true.
- If the component can be cleanly isolated by cropping the current image, provide normalized cropBox [x1, y1, x2, y2] in 0..1 coordinates around ONLY the target component (else return []).
NEVER call run_command, search_web, or edit files. Return ONLY the structured JSON.`
    }));

    const doPick = picker || (async (def, candidates) => runAgyVision({
      model, agyBin, timeoutMs, rootDir, schema: PICK_SCHEMA,
      prompt: `Call read_file in parallel on ALL of these candidate photos for "${def.name}":
${candidates.map((c, idx) => `${idx}: ${c.filePath}`).join('\n')}
Pick bestIndex (0..${candidates.length - 1}) for the photo that shows ONLY the single target component "${def.name}" most cleanly (NO hands, NO breadboards, NO other boards/chips, NO coins, NO USB cables, NO loose header strips, NO multi-pack piles).
If even the best photo has a small extra item (like a loose header strip or coin beside the board) that can be removed by a rectangular crop, set cropBox to normalized [x1, y1, x2, y2] around ONLY the component (else []).
NEVER call run_command, search_web, or edit files. Return ONLY the structured JSON.`
    }));

    for (const { row, def } of queue) {
      if (signal?.aborted) break;
      if (limit > 0 && stats.processed >= limit) break;

      const assetUrl = def.visual?.assetUrl || '';
      const photoFile = row.image_path
        ? path.resolve(rootDir, row.image_path)
        : assetUrl.startsWith('/local-assets/')
          ? path.join(ARCHIVE, 'images', path.basename(assetUrl))
          : null;

      if (!photoFile || !existsSync(photoFile)) continue;

      log(`[audit] ${row.id}: ${def.name}`);
      try {
        const audit = await doAudit(def, photoFile);
        let action = 'kept';
        let finalClean = Boolean(audit.clean);
        let reason = String(audit.reason || '').slice(0, 400);

        if (!audit.clean) {
          const backupFile = path.join(backupDir, path.basename(photoFile));
          if (!existsSync(backupFile)) copyFileSync(photoFile, backupFile);

          let replaced = false;
          if (audit.needsAlternateAngle && row.product_id) {
            const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mcc-angles-'));
            try {
              const candidates = await fetchAlternateCandidates(row.product_id, row.image_url, tempDir, fetchImpl);
              if (candidates.length) {
                const pick = await doPick(def, candidates);
                const chosen = candidates[pick.bestIndex];
                if (chosen) {
                  if (validCropBox(pick.cropBox)) {
                    await cropImageWithPillow(chosen.filePath, photoFile, pick.cropBox);
                    action = 'replaced_and_cropped';
                    stats.replaced++;
                    stats.cropped++;
                  } else {
                    copyFileSync(chosen.filePath, photoFile);
                    action = 'replaced';
                    stats.replaced++;
                  }
                  db.prepare('UPDATE adafruit_products SET image_url = ? WHERE product_id = ?').run(chosen.url, row.product_id);
                  finalClean = Boolean(pick.clean || validCropBox(pick.cropBox));
                  reason = String(pick.reason || reason).slice(0, 400);
                  replaced = true;
                }
              }
            } finally {
              await rm(tempDir, { recursive: true, force: true });
            }
          }

          if (!replaced && validCropBox(audit.cropBox)) {
            const tmpCrop = `${photoFile}.crop.jpg`;
            await cropImageWithPillow(photoFile, tmpCrop, audit.cropBox);
            copyFileSync(tmpCrop, photoFile);
            rmSync(tmpCrop, { force: true });
            action = 'cropped';
            finalClean = true;
            stats.cropped++;
          }
        } else {
          stats.kept++;
        }

        def.photoAudit = {
          clean: finalClean,
          action,
          reason,
          model,
          auditedAt: new Date().toISOString()
        };
        db.prepare('UPDATE component_catalog SET definition = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(def), new Date().toISOString(), row.id);
        stats.processed++;
        log(`[${action}] ${row.id}: ${reason || (finalClean ? 'Clean solo photo' : 'Needs review')}`);
      } catch (error) {
        stats.errors++;
        log(`[error] ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (delayMs > 0 && !signal?.aborted && (limit === 0 || stats.processed < limit)) {
        await sleep(delayMs, signal);
      }
    }
    return stats;
  } finally {
    db.close();
  }
}

function parseCliArgs(argv) {
  const opts = { model: DEFAULT_MODEL, limit: 0, delayMs: 1500, timeoutMs: 90_000, componentId: null, force: false, statusOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') opts.statusOnly = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--delay-ms') opts.delayMs = Number(argv[++i]);
    else if (a === '--timeout-s') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--id') opts.componentId = String(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/photo-audit-worker.mjs [options]
  --status         Print photo audit stats and exit
  --model <slug>   Gemini model (default: ${DEFAULT_MODEL})
  --limit <N>      Max photos to audit (0 = all pending)
  --id <comp-id>   Audit one specific component ID
  --force          Re-audit already audited photos`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.statusOnly) {
      const db = new DatabaseSync(DEFAULT_DB, { readOnly: true });
      try { console.log(JSON.stringify(getPhotoAuditStats(db), null, 2)); }
      finally { db.close(); }
      process.exit(0);
    }
    const releaseLock = acquireLock(path.join(ARCHIVE, 'photo-audit-worker.lock'));
    const controller = new AbortController();
    const stop = () => { console.log('Stopping photo audit worker…'); controller.abort(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      const result = await runPhotoAuditWorker({ ...opts, signal: controller.signal });
      console.log(`Photo audit finished: ${JSON.stringify(result)}`);
    } finally {
      releaseLock();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
