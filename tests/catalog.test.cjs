const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('../.qa/node_modules/@electric-sql/pglite');
const components = require('../api/components.js');
const build = require('../api/build.js');

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
    assert.equal(path.pathname, '/rest/v1/component_catalog');
    assert.equal(options.headers.apikey, 'local-test');
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
  assert.equal(seeded.body.definitions.length, 8);
  assert.equal(seeded.body.definitions.find(def => def.id === 'battery').variants.length, 5);
  const built = await request(build, 'POST', { action: 'build', apiKey: 'local-test-placeholder-key', idea: 'Add a test part', context: {} });
  assert.equal(built.statusCode, 200);
  assert.deepEqual(built.body.plan, plan);
  assert.equal(built.body.definitions[0].id, discovered.id);
  assert.ok((await request(components, 'GET')).body.definitions.some(def => def.id === discovered.id));

  const owner = '01234567-89ab-4def-8123-456789abcdef';
  const id = '11234567-89ab-4def-8123-456789abcdef';
  const project = { name: 'Demo', nodes: [], wires: [] };
  await db.query('insert into auth.users values ($1)', [owner]);
  await db.query('insert into project_templates (id,owner_id,name,project) values ($1,$2,$3,$4)', [id, owner, project.name, JSON.stringify(project)]);
  await db.query('insert into user_projects (id,user_id,name,project) select id,owner_id,name,project from project_templates');
  const saved = await db.query('select project from user_projects where user_id=$1', [owner]);
  assert.deepEqual(saved.rows[0].project, project);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from user_projects'), /permission denied/);
  await assert.rejects(db.query('select * from project_templates'), /permission denied/);
});
