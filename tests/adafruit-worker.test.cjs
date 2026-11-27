const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function setupTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-worker-'));
  const archive = path.join(dir, '.research', 'adafruit');
  const images = path.join(archive, 'images');
  fs.mkdirSync(images, { recursive: true });
  const dbPath = path.join(archive, 'catalog.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE adafruit_products (
      product_id TEXT PRIMARY KEY, name TEXT NOT NULL, product_url TEXT NOT NULL,
      image_url TEXT, image_path TEXT, image_alt TEXT, candidate INTEGER NOT NULL,
      raw_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE component_catalog (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, definition TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const insertProduct = db.prepare('INSERT INTO adafruit_products VALUES (?,?,?,?,?,?,?,?,?)');
  const insertCatalog = db.prepare('INSERT INTO component_catalog VALUES (?,?,?,?,?,?)');

  const items = [
    { id: '100', name: 'Adafruit Sticker Sheet', candidate: 1, category: 'ACCESSORIES' },
    { id: '200', name: 'Adafruit BME280 Sensor Breakout', candidate: 1, category: 'SENSORS' },
    { id: '300', name: 'Adafruit Feather RP2040', candidate: 1, category: 'MICROCONTROLLERS' },
    { id: '400', name: 'STEMMA QT 4-pin Cable', candidate: 1, category: 'CABLES' }
  ];
  for (const item of items) {
    const imgRel = `.research/adafruit/images/${item.id}.jpg`;
    fs.writeFileSync(path.join(dir, imgRel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    insertProduct.run(
      item.id, item.name, `https://www.adafruit.com/product/${item.id}`,
      null, imgRel, item.name, item.candidate,
      JSON.stringify({ canvas_category: item.category }), now
    );
    insertCatalog.run(
      `adafruit-${item.id}`, item.category, 'draft', 1,
      JSON.stringify({ id: `adafruit-${item.id}`, name: item.name, category: item.category, pins: [], needsPinoutResearch: true, enabled: false }),
      now
    );
  }
  db.close();
  return { dir, archive, dbPath };
}

test('adafruit worker prioritizes boards, auto-skips non-electronics, validates pins/conductors, and commits to SQLite', async t => {
  const worker = await import('../scripts/adafruit-catalog-worker.mjs');
  const { dir, archive, dbPath } = setupTestDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const inspectedOrder = [];
  const fakeResearcher = async row => {
    inspectedOrder.push(String(row.product_id));
    if (row.product_id === '300') {
      return {
        status: 'compatible',
        reason: 'Verified Feather RP2040 pinout.',
        help: '3.3 V logic board. Do not apply 5 V to GPIO pins.',
        pins: [
          { id: '3V', name: '3V', kind: 'power' },
          { id: 'GND', name: 'GND', kind: 'ground' },
          { id: 'D5', name: 'D5', kind: 'bidirectional' }
        ],
        conductors: [],
        sources: [{ label: 'Adafruit Learn Guide', url: 'https://learn.adafruit.com/adafruit-feather-rp2040-pico/pinouts' }]
      };
    }
    if (row.product_id === '200') {
      // Intentionally invalid (missing sources) -> should downgrade to manual_review
      return {
        status: 'compatible',
        reason: 'Incomplete citations',
        help: 'Connect 3.3 V and I2C.',
        pins: [{ id: 'VIN', name: 'VIN', kind: 'power-input' }],
        conductors: [],
        sources: []
      };
    }
    if (row.product_id === '400') {
      return {
        status: 'compatible',
        reason: 'Verified 4-pin pass-through cable.',
        help: 'Passive JST-SH 4-pin cable carrying power, ground, and two signal lines.',
        pins: [
          { id: 'A-VCC', name: 'End A VCC', kind: 'passive-power' },
          { id: 'B-VCC', name: 'End B VCC', kind: 'passive-power' },
          { id: 'A-GND', name: 'End A GND', kind: 'passive-ground' },
          { id: 'B-GND', name: 'End B GND', kind: 'passive-ground' }
        ],
        conductors: [['A-VCC', 'B-VCC'], ['A-GND', 'B-GND']],
        sources: [{ label: 'Adafruit Product Page', url: 'https://www.adafruit.com/product/400' }]
      };
    }
    return { status: 'skip', reason: 'No terminals', help: '', pins: [], conductors: [], sources: [] };
  };

  const result = await worker.runWorker({
    dbPath,
    archiveDir: archive,
    rootDir: dir,
    delayMs: 0,
    concurrency: 1,
    importLegacy: false,
    researcher: fakeResearcher,
    log: () => {}
  });

  // Feather RP2040 (board=0) should run first, then newest priority-1 module (400) before 200; Sticker auto-skips without calling AI!
  assert.deepEqual(inspectedOrder, ['300', '400', '200']);
  assert.equal(result.compatible, 2);
  assert.equal(result.manualReview, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors, 0);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stats = worker.getCatalogStats(db);
    assert.equal(stats.ready, 2);
    assert.equal(stats.manual_review, 1);
    assert.equal(stats.skip, 1);

    const feather = JSON.parse(db.prepare("SELECT definition FROM component_catalog WHERE id = 'adafruit-300'").get().definition);
    assert.equal(feather.enabled, true);
    assert.equal(feather.needsPinoutResearch, false);
    assert.equal(feather.pins[2].kind, 'bidirectional');
    assert.equal(feather.visual.assetUrl, '/local-assets/300.jpg');

    const cable = JSON.parse(db.prepare("SELECT definition FROM component_catalog WHERE id = 'adafruit-400'").get().definition);
    assert.deepEqual(cable.conductors, [['A-VCC', 'B-VCC'], ['A-GND', 'B-GND']]);
  } finally {
    db.close();
  }
});

test('adafruit worker publishes verified component to Supabase and strips local-only image paths', async () => {
  const worker = await import('../scripts/adafruit-catalog-worker.mjs');
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(null, { status: 201 });
  };
  await worker.publishToSupabase({
    id: 'adafruit-300',
    category: 'MICROCONTROLLERS',
    localImagePath: '.research/adafruit/images/300.jpg',
    visual: { assetUrl: '/local-assets/300.jpg', alt: 'Feather' },
    pins: [{ id: 'D5', name: 'D5', kind: 'bidirectional' }]
  }, { url: 'https://example.supabase.co', key: 'secret-key', status: 'draft', fetchImpl: fakeFetch });

  assert.equal(captured.url, 'https://example.supabase.co/rest/v1/component_catalog?on_conflict=id');
  assert.equal(captured.body[0].status, 'draft');
  assert.equal(captured.body[0].definition.localImagePath, undefined);
  assert.equal(captured.body[0].definition.visual.assetUrl, undefined);
});

test('adafruit worker defaults to Gemini, parses agy JSON output, and supports Gemini REST API', async t => {
  const worker = await import('../scripts/adafruit-catalog-worker.mjs');
  assert.equal(worker.DEFAULT_PROVIDER, 'gemini');
  assert.match(worker.DEFAULT_MODEL, /^gemini-/);

  const parsed = worker.parseAgyOutput(JSON.stringify({
    status: 'SUCCESS',
    structured_output: {
      status: 'compatible',
      reason: 'Verified',
      help: '3.3 V logic',
      pins: [{ id: 'GND', name: 'GND', kind: 'ground' }],
      conductors: [],
      sources: [{ label: 'Guide', url: 'https://learn.adafruit.com/test' }]
    }
  }));
  assert.equal(parsed.status, 'compatible');
  assert.equal(parsed.pins[0].id, 'GND');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-gemini-api-'));
  const img = path.join(tmpDir, 'test.jpg');
  fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let capturedUrl = '';
  let capturedBody = null;
  const apiResult = await worker.researchWithGeminiApi({
    row: { product_id: '999', name: 'Test Sensor', product_url: 'https://www.adafruit.com/product/999' },
    photoPath: img,
    apiKey: 'test-gemini-key',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                status: 'skip', reason: 'Mechanical bracket', help: '', pins: [], conductors: [], sources: []
              })
            }]
          }
        }]
      });
    }
  });
  assert.match(capturedUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/);
  assert.ok(capturedBody.tools.some(tool => tool.googleSearch));
  assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(apiResult.status, 'skip');
});
