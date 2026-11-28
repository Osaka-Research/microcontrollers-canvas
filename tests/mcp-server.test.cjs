const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const initialCatalog = require('../scripts/initial-component-catalog.cjs');

function spawnMcpClient(env) {
  const child = spawn(process.execPath, [path.resolve('scripts/mcc-mcp-server.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 15000);
      pending.set(id, msg => { clearTimeout(t); resolve(msg); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }
  function close() {
    child.stdin.end();
    child.kill();
  }
  return { send, close, child };
}

test('MCC MCP server handles initialize, catalog search, circuit validation, BOM export, and real MicroPython simulation over stdio', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-mcp-'));
  const dbPath = path.join(tmpDir, 'catalog.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE component_catalog (id TEXT PRIMARY KEY, category TEXT, status TEXT, version INTEGER, definition TEXT, updated_at TEXT);
    CREATE TABLE adafruit_products (product_id TEXT PRIMARY KEY, raw_json TEXT);
  `);
  const insert = db.prepare(`INSERT INTO component_catalog VALUES (?, ?, 'published', 1, ?, ?)`);
  for (const d of initialCatalog.filter(x => x.enabled !== false)) {
    insert.run(d.id, d.category, JSON.stringify({ ...d, needsPinoutResearch: 0 }), new Date().toISOString());
  }
  db.close();

  const mcp = spawnMcpClient({ LOCAL_COMPONENT_DB: dbPath });
  t.after(() => {
    mcp.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const init = await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  assert.equal(init.result.serverInfo.name, 'microcontrollers-canvas');

  const listed = await mcp.send('tools/list', {});
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(names, [
    'mcc_search_parts',
    'mcc_get_part',
    'mcc_build_and_validate_circuit',
    'mcc_simulate_micropython',
    'mcc_export_wiring_guide',
    'mcc_list_projects'
  ]);

  // Search parts
  const searchRes = await mcp.send('tools/call', { name: 'mcc_search_parts', arguments: { query: 'potentiometer' } });
  const searchData = JSON.parse(searchRes.result.content[0].text);
  assert.ok(searchData.parts.some(p => p.id === 'potentiometer'));

  // Get part details
  const partRes = await mcp.send('tools/call', { name: 'mcc_get_part', arguments: { id: 'esp8266' } });
  const partData = JSON.parse(partRes.result.content[0].text);
  assert.equal(partData.id, 'esp8266');
  assert.ok(partData.pins.length === 30);

  // Build & validate circuit (NodeMCU D4 -> Resistor -> LED Anode, GND -> LED Cathode) + save
  const buildRes = await mcp.send('tools/call', {
    name: 'mcc_build_and_validate_circuit',
    arguments: {
      name: 'Safe Blink',
      components: [
        { type: 'esp8266' },
        { type: 'resistor', ohms: 220 },
        { type: 'led' }
      ],
      wires: [
        { aComponent: 0, aPin: 4, bComponent: 1, bPin: 0 },
        { aComponent: 1, aPin: 1, bComponent: 2, bPin: 0 },
        { aComponent: 0, aPin: 12, bComponent: 2, bPin: 1 }
      ],
      micropythonScript: 'from machine import Pin\nPin(2, Pin.OUT).value(1)',
      save: true,
      pushToCanvas: false
    }
  });
  assert.notEqual(buildRes.result.isError, true);
  const built = JSON.parse(buildRes.result.content[0].text);
  assert.equal(built.valid, true);
  assert.equal(built.diagnostics.length, 0);
  assert.ok(built.saved.id);
  assert.match(built.wiringGuide, /Bill of Materials/);
  assert.match(built.wiringGuide, /Pin-to-Pin Connections/);

  // Reject invalid wire (LED anode to LED anode)
  const badRes = await mcp.send('tools/call', {
    name: 'mcc_build_and_validate_circuit',
    arguments: {
      components: [{ type: 'led' }, { type: 'led' }],
      wires: [{ aComponent: 0, aPin: 0, bComponent: 1, bPin: 0 }]
    }
  });
  assert.equal(badRes.result.isError, true);
  assert.match(badRes.result.content[0].text, /rejected by RobotModel/);

  // List projects + export wiring guide by saved project ID
  const projList = JSON.parse((await mcp.send('tools/call', { name: 'mcc_list_projects', arguments: {} })).result.content[0].text);
  assert.equal(projList.projects.length, 1);
  assert.equal(projList.projects[0].id, built.saved.id);

  const guide = JSON.parse((await mcp.send('tools/call', { name: 'mcc_export_wiring_guide', arguments: { projectId: built.saved.id } })).result.content[0].text);
  assert.match(guide.markdown, /Safe Blink/);

  // Real MicroPython simulation over MCP with A0 ADC=0.5 + FRC1 PWM on D4 (GPIO2)
  const simRes = await mcp.send('tools/call', {
    name: 'mcc_simulate_micropython',
    arguments: {
      code: 'from machine import Pin, PWM, ADC\nprint("READ_ADC:", ADC(0).read())\np = PWM(Pin(2), freq=200, duty=512)',
      adc: 0.5,
      runMs: 250
    }
  });
  assert.notEqual(simRes.result.isError, true);
  const sim = JSON.parse(simRes.result.content[0].text);
  const adcNum = Number(sim.serialOutput.match(/READ_ADC:\s*(\d+)/)?.[1]);
  assert.ok(adcNum >= 480 && adcNum <= 540, `Expected ADC ~512, got ${adcNum}`);
  const d4 = sim.activePins['D4 (GPIO2)'];
  assert.ok(d4, 'Expected D4 (GPIO2) active');
  assert.ok(d4.freqHz >= 180 && d4.freqHz <= 220, `Expected ~200 Hz, got ${d4.freqHz}`);
  assert.ok(d4.duty >= 0.44 && d4.duty <= 0.56, `Expected ~0.50 duty, got ${d4.duty}`);
});
