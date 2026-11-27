const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('photo audit worker crops cluttered images with Pillow and backs up originals', async t => {
  const worker = await import('../scripts/photo-audit-worker.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-photo-test-'));
  const imgDir = path.join(tmpDir, '.research', 'adafruit', 'images');
  const backupDir = path.join(tmpDir, '.research', 'adafruit', 'images-originals');
  fs.mkdirSync(imgDir, { recursive: true });
  const imgRel = '.research/adafruit/images/999.jpg';
  const imgAbs = path.join(tmpDir, imgRel);
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Generate a 200x100 JPEG test image using Pillow
  const mk = spawnSync('python3', ['-c', `from PIL import Image; Image.new('RGB',(200,100),(40,80,120)).save('${imgAbs}','JPEG')`]);
  assert.equal(mk.status, 0);

  const dbPath = path.join(tmpDir, 'catalog.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE adafruit_products (product_id TEXT PRIMARY KEY, name TEXT, image_path TEXT, image_url TEXT);
    CREATE TABLE component_catalog (id TEXT PRIMARY KEY, category TEXT, status TEXT, version INTEGER, definition TEXT, updated_at TEXT);
  `);
  db.prepare('INSERT INTO adafruit_products VALUES (?,?,?,?)').run('999', 'Test Sensor', imgRel, 'https://cdn-shop.adafruit.com/640x480/999-05.jpg');
  db.prepare('INSERT INTO component_catalog VALUES (?,?,?,?,?,?)').run(
    'adafruit-999', 'SENSORS', 'draft', 1,
    JSON.stringify({ id: 'adafruit-999', sourceProductId: '999', name: 'Test Sensor', enabled: true, needsPinoutResearch: false, pins: [{ id: 'v', name: 'VCC', kind: 'power-input' }], visual: { assetUrl: '/local-assets/999.jpg' } }),
    new Date().toISOString()
  );
  db.close();

  const result = await worker.runPhotoAuditWorker({
    dbPath,
    rootDir: tmpDir,
    backupDir,
    delayMs: 0,
    auditor: async () => ({
      clean: false,
      reason: 'Shows extra breadboard on left half; cropping right half isolates sensor.',
      needsAlternateAngle: false,
      cropBox: [0.5, 0.1, 0.95, 0.9]
    }),
    log: () => {}
  });

  assert.equal(result.cropped, 1);
  assert.equal(fs.existsSync(path.join(backupDir, '999.jpg')), true);

  // Verify cropped image is actually smaller than original 200x100
  const dim = spawnSync('python3', ['-c', `from PIL import Image; print(Image.open('${imgAbs}').size)`], { encoding: 'utf8' });
  assert.notEqual(dim.stdout.trim(), '(200, 100)');

  const dbRead = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const def = JSON.parse(dbRead.prepare("SELECT definition FROM component_catalog WHERE id = 'adafruit-999'").get().definition);
    assert.equal(def.photoAudit.clean, true);
    assert.equal(def.photoAudit.action, 'cropped');
  } finally {
    dbRead.close();
  }
});
