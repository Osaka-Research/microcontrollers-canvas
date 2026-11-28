const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = (() => { try { return require('@electric-sql/pglite'); } catch { return require('../.qa/node_modules/@electric-sql/pglite'); } })();
const components = require('../api/components.js');
const templates = require('../api/templates.js');
const build = require('../api/build.js');
const { resetRateLimits } = require('../api/lib/rate-limit.js');

async function request(handler, method, body) {
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method, headers: {}, body }, res);
  return res;
}

test('seed, catalog API, build API and project tables use the migrated database', async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  const migration = readFileSync('supabase/migrations/20261126_component_catalog.sql', 'utf8');
  await db.exec(migration);
  await db.exec(migration);

  const url = 'https://catalog.example';
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SECRET_KEY = 'local-test';
  const discovered = { id: 'testpart', name: 'Test part', category: 'Test', label: 'Test',
    help: '', icon: '', subtitle: '', pins: [{ id: 'in', kind: 'input', name: 'IN' }],
    sources: [{ label: 'Test reference', url: 'https://example.org/reference' }],
    visual: { imageUrl: '', imageSource: '', symbol: '+' } };
  const plan = { summary: 'Add the test part.', components: [{ type: 'testpart', pack: '' }], wires: [] };
  t.mock.method(global, 'fetch', async (address, options) => {
    const path = new URL(address);
    if (path.origin === 'https://api.openai.com') {
      const payload = JSON.parse(options.body);
      const result = payload.text.format.name === 'missing_components' ? { components: [discovered] } : plan;
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    }
    assert.equal(path.origin, url);
    assert.equal(options.headers.apikey, 'local-test');
    if (path.pathname === '/rest/v1/project_templates') {
      assert.equal(path.searchParams.get('visibility'), 'eq.public');
      return Response.json((await db.query("select id,name,description,project,updated_at from project_templates where visibility='public' order by updated_at desc")).rows);
    }
    assert.equal(path.pathname, '/rest/v1/component_catalog');
    if (options.method === 'POST') {
      for (const row of JSON.parse(options.body)) {
        await db.query('insert into component_catalog (id, category, status, version, definition) values ($1,$2,$3,$4,$5) on conflict do nothing',
          [row.id, row.category, row.status, row.version, JSON.stringify(row.definition)]);
      }
      return new Response(null, { status: 201 });
    }
    assert.equal(path.searchParams.get('status'), 'eq.published');
    return Response.json((await db.query("select definition from component_catalog where status='published' order by category,id")).rows);
  });
  await import('../scripts/seed-component-catalog.mjs');
  const seeded = await request(components, 'GET');
  assert.equal(seeded.statusCode, 200);
  assert.equal(seeded.body.definitions.length, 12);
  assert.equal(seeded.body.definitions.find(def => def.id === 'battery').variants.length, 5);
  const built = await request(build, 'POST', { action: 'build', apiKey: 'local-test-placeholder-key', idea: 'Add a test part', context: {} });
  assert.equal(built.statusCode, 200);
  assert.deepEqual(built.body.plan, { ...plan, components: [{ type: 'testpart', pack: '', pinDirections: [] }] });
  assert.equal(built.body.definitions[0].id, discovered.id);
  // AI-discovered parts are saved as unreviewed drafts, not auto-published to all visitors.
  assert.equal((await request(components, 'GET')).body.definitions.some(def => def.id === discovered.id), false);
  const draftRow = await db.query('select status, definition from component_catalog where id=$1', [discovered.id]);
  assert.equal(draftRow.rows[0].status, 'draft');
  assert.equal(draftRow.rows[0].definition.needsPinoutResearch, true);
  resetRateLimits();

  const owner = '01234567-89ab-4def-8123-456789abcdef';
  const id = '11234567-89ab-4def-8123-456789abcdef';
  const project = { name: 'Demo', nodes: [], wires: [] };
  await db.query('insert into auth.users values ($1)', [owner]);
  await db.query("insert into project_templates (id,owner_id,name,visibility,project) values ($1,$2,$3,'public',$4)", [id, owner, project.name, JSON.stringify(project)]);
  const tplRes = await request(templates, 'GET');
  assert.equal(tplRes.statusCode, 200);
  assert.equal(tplRes.body.templates.length, 1);
  assert.equal(tplRes.body.templates[0].name, 'Demo');
  await db.query('insert into user_projects (id,user_id,name,project) select id,owner_id,name,project from project_templates');
  const saved = await db.query('select project from user_projects where user_id=$1', [owner]);
  assert.deepEqual(saved.rows[0].project, project);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from user_projects'), /permission denied/);
  await assert.rejects(db.query('select * from project_templates'), /permission denied/);
});

test('build API accepts 127.0.0.1 local origin, enforces 1200-char idea limit, and returns discovered local parts', async t => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-local-'));
  const dbPath = path.join(tmpDir, 'catalog.sqlite');
  const prevLocalDb = process.env.LOCAL_COMPONENT_DB;
  const prevRoot = process.env.LOCAL_CATALOG_ROOT;
  const prevOrigin = process.env.CANVAS_ORIGIN;

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE component_catalog (id TEXT PRIMARY KEY, category TEXT, status TEXT, version INTEGER, definition TEXT, updated_at TEXT);
    CREATE TABLE adafruit_products (product_id TEXT PRIMARY KEY, raw_json TEXT);
  `);
  const seed = require('../scripts/initial-component-catalog.cjs').find(d => d.enabled !== false);
  db.prepare(`INSERT INTO component_catalog VALUES (?, ?, 'published', 1, ?, ?)`).run(
    seed.id, seed.category, JSON.stringify({ ...seed, needsPinoutResearch: 0 }), new Date().toISOString()
  );
  db.close();

  process.env.LOCAL_COMPONENT_DB = dbPath;
  process.env.LOCAL_CATALOG_ROOT = tmpDir;
  delete process.env.CANVAS_ORIGIN;
  t.after(() => {
    if (prevLocalDb === undefined) delete process.env.LOCAL_COMPONENT_DB; else process.env.LOCAL_COMPONENT_DB = prevLocalDb;
    if (prevRoot === undefined) delete process.env.LOCAL_CATALOG_ROOT; else process.env.LOCAL_CATALOG_ROOT = prevRoot;
    if (prevOrigin === undefined) delete process.env.CANVAS_ORIGIN; else process.env.CANVAS_ORIGIN = prevOrigin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const discovered = {
    id: 'localpart', name: 'Local test part', category: 'Test', label: 'Local part',
    help: '', icon: '', subtitle: '', pins: [{ id: 'in', kind: 'input', name: 'IN' }],
    conductors: [],
    sources: [{ label: 'Datasheet', url: 'https://example.org/datasheet' }],
    visual: { imageUrl: '', imageSource: '', symbol: '+' }
  };
  const plan = { summary: 'Add localpart.', components: [{ type: 'localpart', pack: '', pinDirections: [] }], wires: [] };

  t.mock.method(global, 'fetch', async (_address, options) => {
    const payload = JSON.parse(options.body);
    const result = payload.text.format.name === 'missing_components' ? { components: [discovered] } : plan;
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  });

  async function reqWithOrigin(body) {
    const headers = {};
    const res = {
      setHeader(k, v) { headers[k] = v; },
      end(value) { this.body = value ? JSON.parse(value) : null; this.headers = headers; }
    };
    await build({ method: 'POST', headers: { origin: 'http://127.0.0.1:4173' }, body }, res);
    return res;
  }

  const tooLong = await reqWithOrigin({ action: 'build', apiKey: 'local-test-placeholder-key', idea: 'a'.repeat(1201), context: {} });
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:4173');

  const ok = await reqWithOrigin({ action: 'build', apiKey: 'local-test-placeholder-key', idea: 'Add localpart', context: {} });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:4173');
  assert.ok(ok.body.definitions.some(def => def.id === 'localpart'));
});
