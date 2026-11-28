const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return require('../.qa/node_modules/jsdom'); } })();

const build = require('../api/build.js');
const components = require('../api/components.js');
const templates = require('../api/templates.js');
const projects = require('../api/projects.js');
const { checkLocalRequest } = require('../api/lib/local-guard.js');
const { validateBuildPlan } = require('../api/lib/plan-validator.js');
const { resetRateLimits } = require('../api/lib/rate-limit.js');
const { invalidateLocalCache } = require('../api/lib/catalog.js');
const initialCatalog = require('../scripts/initial-component-catalog.cjs');

test('local-guard blocks DNS rebinding, cross-origin requests, and missing Origin on ChatGPT auth POSTs', () => {
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:4173' }, pathname: '/' }, 4173).ok, true);
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, pathname: '/' }, 4173).ok, true);
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site' }, pathname: '/api/chatgpt/session' }, 4173).ok, false);
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: 'localhost:4173' }, pathname: '/healthz' }, 4173).ok, true);
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: 'evil.example:4173' }, pathname: '/api/chatgpt/session' }, 4173).ok, false);
  assert.equal(checkLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:9999' }, pathname: '/' }, 4173).ok, false);
  assert.equal(checkLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:4173', origin: 'https://evil.example' }, pathname: '/api/chatgpt/sign-in' }, 4173).ok, false);
  assert.equal(checkLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:4173' }, pathname: '/api/chatgpt/sign-in' }, 4173).ok, false);
  assert.equal(checkLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' }, pathname: '/api/chatgpt/sign-in' }, 4173).ok, true);
  assert.equal(checkLocalRequest({ method: 'POST', headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'cross-site' }, pathname: '/api/chatgpt/disconnect' }, 4173).ok, false);
});

test('validateBuildPlan enforces pin compatibility and single-driver passive conductor rules server-side', () => {
  const cable = {
    id: 'cable', name: 'Cable', category: 'Cables', renderer: 'generic', enabled: true,
    pins: [
      { id: 'a', name: 'A', kind: 'passive-signal' },
      { id: 'b', name: 'B', kind: 'passive-signal' },
      { id: 'c', name: 'C', kind: 'passive-signal' }
    ],
    conductors: [['a', 'b', 'c']]
  };
  const catalog = [...initialCatalog, cable];

  // Valid plan: NodeMCU D4 (pin 4, output) -> LED anode (pin 0, drive-input)
  const validPlan = {
    summary: 'Connect LED to NodeMCU.',
    components: [{ type: 'esp8266', pack: '', pinDirections: [] }, { type: 'led', pack: '', pinDirections: [] }],
    wires: [{ aComponent: 0, aPin: 4, bComponent: 1, bPin: 0 }]
  };
  assert.equal(validateBuildPlan(validPlan, [], catalog).ok, true);

  // Invalid plan: LED anode wired to LED cathode (incompatible pin kinds)
  const badWire = {
    summary: 'Bad wire.',
    components: [{ type: 'led', pack: '', pinDirections: [] }, { type: 'led', pack: '', pinDirections: [] }],
    wires: [{ aComponent: 0, aPin: 0, bComponent: 1, bPin: 0 }]
  };
  assert.equal(validateBuildPlan(badWire, [], catalog).ok, false);

  // Invalid plan: two outputs driving the same passive conductor
  const dualDriver = {
    summary: 'Two drivers on one conductor.',
    components: [
      { type: 'esp8266', pack: '', pinDirections: [] },
      { type: 'cable', pack: '', pinDirections: [] }
    ],
    wires: [
      { aComponent: 0, aPin: 1, bComponent: 1, bPin: 0 },
      { aComponent: 0, aPin: 2, bComponent: 1, bPin: 1 }
    ]
  };
  assert.equal(validateBuildPlan(dualDriver, [], catalog).ok, false);
});

test('shouldDiscoverMissing skips extra AI call for known catalog parts and runs it for unknown parts', () => {
  assert.equal(build.shouldDiscoverMissing('Connect an LED and servo to NodeMCU with battery', initialCatalog), false);
  assert.equal(build.shouldDiscoverMissing('Add a BME280 sensor to NodeMCU', initialCatalog), true);
  assert.equal(build.shouldDiscoverMissing('Add a test part', initialCatalog), true);
});

test('/api/build enforces rate limits, falls back on discovery failure, and supports ETag/304 on catalog & templates', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-sec-'));
  const dbPath = path.join(tmpDir, 'catalog.sqlite');
  const prevLocalDb = process.env.LOCAL_COMPONENT_DB;
  const prevRateMax = process.env.BUILD_RATE_LIMIT_MAX;
  const prevKeyMax = process.env.BUILD_KEY_RATE_LIMIT_MAX;

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE component_catalog (id TEXT PRIMARY KEY, category TEXT, status TEXT, version INTEGER, definition TEXT, updated_at TEXT);
    CREATE TABLE adafruit_products (product_id TEXT PRIMARY KEY, raw_json TEXT);
    CREATE TABLE project_templates (id TEXT PRIMARY KEY, name TEXT, category TEXT, difficulty TEXT, description TEXT, real_world_notes TEXT, project TEXT, status TEXT, updated_at TEXT);
  `);
  const insert = db.prepare(`INSERT INTO component_catalog VALUES (?, ?, 'published', 1, ?, ?)`);
  for (const def of initialCatalog.filter(d => d.enabled !== false)) {
    insert.run(def.id, def.category, JSON.stringify({ ...def, needsPinoutResearch: 0 }), new Date().toISOString());
  }
  db.prepare(`INSERT INTO project_templates VALUES ('t1','Demo','TEST','Beginner','Desc','Notes',?,'ready',?)`)
    .run(JSON.stringify({ name: 'Demo', nodes: [], wires: [] }), new Date().toISOString());
  db.close();

  process.env.LOCAL_COMPONENT_DB = dbPath;
  process.env.BUILD_RATE_LIMIT_MAX = '2';
  process.env.BUILD_KEY_RATE_LIMIT_MAX = '2';
  resetRateLimits();
  invalidateLocalCache();

  t.after(() => {
    resetRateLimits();
    invalidateLocalCache();
    if (prevLocalDb === undefined) delete process.env.LOCAL_COMPONENT_DB; else process.env.LOCAL_COMPONENT_DB = prevLocalDb;
    if (prevRateMax === undefined) delete process.env.BUILD_RATE_LIMIT_MAX; else process.env.BUILD_RATE_LIMIT_MAX = prevRateMax;
    if (prevKeyMax === undefined) delete process.env.BUILD_KEY_RATE_LIMIT_MAX; else process.env.BUILD_KEY_RATE_LIMIT_MAX = prevKeyMax;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ETag + 304 on /api/components and /api/templates
  async function callGet(handler, headers = {}) {
    const outHeaders = {};
    const res = {
      statusCode: 0,
      setHeader(k, v) { outHeaders[k.toLowerCase()] = v; },
      end(v) { this.raw = v; this.headers = outHeaders; }
    };
    await handler({ method: 'GET', headers }, res);
    return res;
  }
  const c1 = await callGet(components);
  assert.equal(c1.statusCode, 200);
  assert.ok(c1.headers.etag);
  const c2 = await callGet(components, { 'if-none-match': c1.headers.etag });
  assert.equal(c2.statusCode, 304);

  const t1 = await callGet(templates);
  assert.equal(t1.statusCode, 200);
  const t2 = await callGet(templates, { 'if-none-match': t1.headers.etag });
  assert.equal(t2.statusCode, 304);

  // Discovery failure falls back to building with existing catalog, and rate limit kicks in on 3rd request
  let aiCalls = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    aiCalls++;
    const payload = JSON.parse(options.body);
    if (payload.text?.format?.name === 'missing_components') {
      return new Response(JSON.stringify({ error: { message: 'Temporary discovery failure' } }), { status: 500 });
    }
    return Response.json({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({ summary: 'Built with LED.', components: [{ type: 'led', pack: '', pinDirections: [] }], wires: [] })
        }]
      }]
    });
  });

  async function callBuild(idea) {
    const outHeaders = {};
    const res = {
      statusCode: 0,
      setHeader(k, v) { outHeaders[k.toLowerCase()] = v; },
      end(v) { this.body = v ? JSON.parse(v) : null; this.headers = outHeaders; }
    };
    await build({
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body: { action: 'build', apiKey: 'sk-test-rate-limit-key-12345', idea, context: {} }
    }, res);
    return res;
  }

  // Request 1: unknown part triggers discovery (fails) -> falls back to build and succeeds!
  const r1 = await callBuild('Add a fluxcapacitor and an LED');
  assert.equal(r1.statusCode, 200);
  assert.equal(aiCalls, 2);

  // Request 2: known catalog parts -> skips discovery (only 1 AI call!)
  const r2 = await callBuild('Add an LED');
  assert.equal(r2.statusCode, 200);
  assert.equal(aiCalls, 3);

  // Request 3: exceeds rate limit (max 2) -> 429 with Retry-After
  const r3 = await callBuild('Add an LED');
  assert.equal(r3.statusCode, 429);
  assert.ok(Number(r3.headers['retry-after']) >= 1);

  // Local SQLite /api/projects CRUD
  async function callProjects(method, { url = '/api/projects', body } = {}) {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(v) { this.body = v ? JSON.parse(v) : null; }
    };
    await projects({ method, url, headers: {}, body }, res);
    return res;
  }
  const saved = await callProjects('POST', { body: { name: 'Blink Test', project: { name: 'Blink Test', nodes: [], wires: [] } } });
  assert.equal(saved.statusCode, 200);
  const projectId = saved.body.project.id;
  const listed = await callProjects('GET');
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.projects.length, 1);
  assert.equal(listed.body.projects[0].id, projectId);
  const del = await callProjects('DELETE', { url: `/api/projects?id=${projectId}` });
  assert.equal(del.statusCode, 200);
  assert.equal((await callProjects('GET')).body.projects.length, 0);
});

test('frontend migrates legacy robot-canvas-v1 key to mcc-project-v1 and marks visual-only generic parts', () => {
  const dom = new JSDOM(fs.readFileSync('dist/index.html', 'utf8'), { url: 'http://127.0.0.1:4173', runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.localStorage.setItem('robot-canvas-v1', JSON.stringify({ name: 'Legacy Build', nodes: [], wires: [] }));
  const ctx = dom.getInternalVMContext();
  for (const file of ['firmware-engine.js', 'component-registry.js', 'model.js', 'app.js', 'developer.js', 'firmware.js', 'wiring.js']) {
    vm.runInContext(fs.readFileSync('dist/' + file, 'utf8'), ctx, { filename: file });
  }
  try {
    const sensor = {
      id: 'bme280', name: 'BME280 Sensor', category: 'SENSORS', renderer: 'generic', behavior: 'none', enabled: true,
      pins: [{ id: 'vin', name: 'VIN', kind: 'power-input' }, { id: 'gnd', name: 'GND', kind: 'ground-input' }]
    };
    w.refreshComponentRegistry([...initialCatalog, sensor]);
    assert.equal(w.document.documentElement.dataset.theme, 'blueprint');
    assert.equal(w.document.querySelector('#themeMenu [data-theme="blueprint"]').getAttribute('aria-checked'), 'true');
    assert.equal(w.document.querySelector('#projectName').value, 'Legacy Build');
    assert.ok(w.localStorage.getItem('mcc-project-v1'));
    assert.equal(w.localStorage.getItem('robot-canvas-v1'), null);

    vm.runInContext("add('bme280')", ctx);
    assert.match(w.document.querySelector('#nodes').textContent, /VISUAL ONLY/);
    assert.match(w.document.querySelector('#inspectorContent').textContent, /not simulated/i);
  } finally {
    dom.window.close();
  }
});
