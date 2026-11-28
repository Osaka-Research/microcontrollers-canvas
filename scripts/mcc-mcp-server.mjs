#!/usr/bin/env node
/**
 * MCC MCP Server (Model Context Protocol, JSON-RPC 2.0 over stdio).
 * Lets AI agents (Claude, Codex, Antigravity, Cursor, Gemini CLI) search MCC's
 * verified component catalog, validate circuits against RobotModel, run real
 * ESP8266 MicroPython simulations, export wiring guides/BOMs, and push live
 * circuits onto the user's open MCC blueprint canvas.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.research', 'adafruit');
const LIVE_CANVAS_FILE = path.join(DATA_DIR, 'live-canvas.json');
process.env.LOCAL_CATALOG_ROOT ||= ROOT;
if (!process.env.LOCAL_COMPONENT_DB && fs.existsSync(path.join(DATA_DIR, 'catalog.sqlite'))) {
  process.env.LOCAL_COMPONENT_DB = path.join(DATA_DIR, 'catalog.sqlite');
}

const ComponentRegistry = require('../dist/component-registry.js');
const RobotModel = require('../dist/model.js');
const initialCatalog = require('./initial-component-catalog.cjs');
const { publishedCatalog } = require('../api/lib/catalog.js');

const SERVER_INFO = { name: 'microcontrollers-canvas', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

async function loadCatalog() {
  try {
    return await publishedCatalog();
  } catch {
    return initialCatalog.filter(d => d.enabled !== false);
  }
}

function syncRegistry(catalog) {
  const valid = catalog.filter(d => d && typeof d.id === 'string' && d.id !== 'board' && Array.isArray(d.pins));
  ComponentRegistry.replace(valid);
  return new Map(valid.map(d => [d.id, d]));
}

function ensureProjectsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function buildValidatedProject({ name = 'Agent Circuit', components = [], wires = [], micropythonScript = '' }, catalog) {
  const byId = syncRegistry(catalog);
  if (!Array.isArray(components) || !Array.isArray(wires)) {
    throw new Error('components and wires must be arrays.');
  }
  if (components.length > 150 || wires.length > 600) {
    throw new Error('Project exceeds MCC limits (150 components, 600 wires).');
  }

  const colY = [80, 80, 80];
  const colX = [80, 360, 660];
  const nodes = [];

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (!c || typeof c.type !== 'string') throw new Error(`Component ${i} is missing a valid "type".`);
    const def = byId.get(c.type);
    if (!def || def.enabled === false) throw new Error(`Unknown or disabled component type: ${c.type}`);
    let pack = typeof c.pack === 'string' ? c.pack : '';
    if (Array.isArray(def.variants) && def.variants.length) {
      if (!pack) pack = def.variants[0].id;
      if (!def.variants.some(v => v.id === pack)) {
        throw new Error(`Invalid variant "${pack}" for ${c.type}. Valid: ${def.variants.map(v => v.id).join(', ')}`);
      }
    }

    const pinDirsInput = Array.isArray(c.pinDirections) ? c.pinDirections : [];
    const pinDirections = c.type === 'esp8266'
      ? def.pins.map((p, idx) => {
          const override = pinDirsInput.find(d => d && d.pin === idx);
          if (override) {
            if (p.gpio == null || !['input', 'output'].includes(override.direction)) {
              throw new Error(`Invalid pinDirection for NodeMCU pin ${idx} (${p.name}).`);
            }
            return override.direction;
          }
          return p.kind;
        })
      : def.pins.some(p => p.kind === 'bidirectional')
        ? def.pins.map((p, idx) => {
            if (p.kind !== 'bidirectional') return p.kind;
            const override = pinDirsInput.find(d => d && d.pin === idx);
            if (override && !['input', 'output'].includes(override.direction)) {
              throw new Error(`Invalid pinDirection for ${c.type} pin ${idx}.`);
            }
            return override?.direction || 'input';
          })
        : undefined;

    const col = ['esp8266', 'battery', 'pushbutton', 'potentiometer'].includes(c.type) ? 0
      : (c.type === 'motorDriver' || c.type === 'resistor' || def.conductors?.length) ? 1 : 2;
    const x = Number.isFinite(c.x) ? Math.round(c.x) : colX[col];
    const y = Number.isFinite(c.y) ? Math.round(c.y) : colY[col];
    if (!Number.isFinite(c.y)) colY[col] += (c.type === 'esp8266' ? 380 : c.type === 'motorDriver' ? 480 : 230);

    const node = {
      id: typeof c.id === 'string' && /^[\w-]{1,80}$/.test(c.id) ? c.id : `n${i + 1}`,
      type: c.type,
      ...(def.variants?.length ? { pack } : {}),
      x,
      y,
      modes: c.type === 'esp8266'
        ? def.pins.map(() => 'low')
        : def.renderer === 'generic'
          ? def.pins.map(() => 'low')
          : ['blink', 'low', 'low', 'low'],
      period: 1,
      ...(pinDirections ? { pinDirections } : {}),
      ...(c.type === 'esp8266'
        ? {
            firmware: { preset: micropythonScript ? 'micropython' : (c.firmwarePreset || 'micropython') },
            ...(micropythonScript ? { _script: String(micropythonScript).slice(0, 1900) } : {})
          }
        : {}),
      ...(c.type === 'potentiometer' && Number.isFinite(c.value) ? { value: Math.max(0, Math.min(1, c.value)) } : {}),
      ...(c.type === 'resistor' && Number.isFinite(c.ohms) ? { ohms: c.ohms } : {})
    };
    nodes.push(node);
  }

  const project = {
    name: String(name || 'Agent Circuit').trim().slice(0, 60) || 'Agent Circuit',
    boards: [],
    nodes,
    wires: []
  };

  for (let i = 0; i < wires.length; i++) {
    const w = wires[i];
    if (!w || ![w.aComponent, w.aPin, w.bComponent, w.bPin].every(Number.isInteger)) {
      throw new Error(`Wire ${i} must have integer aComponent, aPin, bComponent, bPin.`);
    }
    if (w.aComponent < 0 || w.aComponent >= nodes.length || w.bComponent < 0 || w.bComponent >= nodes.length) {
      throw new Error(`Wire ${i} component index out of range.`);
    }
    const built = RobotModel.connection(
      project,
      { id: nodes[w.aComponent].id, pin: w.aPin },
      { id: nodes[w.bComponent].id, pin: w.bPin }
    );
    if (!built) {
      const aPins = RobotModel.pins(project, nodes[w.aComponent]);
      const bPins = RobotModel.pins(project, nodes[w.bComponent]);
      throw new Error(
        `Wire ${i} rejected by RobotModel: ${nodes[w.aComponent].type}[${w.aPin}:${aPins[w.aPin]?.name || '?'} (${aPins[w.aPin]?.kind || '?'})] <-> ` +
        `${nodes[w.bComponent].type}[${w.bPin}:${bPins[w.bPin]?.name || '?'} (${bPins[w.bPin]?.kind || '?'})]`
      );
    }
    const key = RobotModel.attachmentKey(project, built);
    if (!project.wires.some(existing => RobotModel.attachmentKey(project, existing) === key)) {
      project.wires.push(built);
    }
  }

  if (!RobotModel.valid(project)) {
    throw new Error('Constructed circuit did not pass RobotModel.valid().');
  }

  const diagnostics = RobotModel.diagnostics(project);
  return { project, diagnostics };
}

function saveProjectLocal(project) {
  const dbPath = process.env.LOCAL_COMPONENT_DB;
  if (!dbPath) return null;
  const db = new DatabaseSync(dbPath);
  try {
    ensureProjectsTable(db);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO user_projects (id, name, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, project.name, JSON.stringify(project), now, now);
    return { id, updatedAt: now };
  } finally {
    db.close();
  }
}

function pushLiveCanvas(project) {
  const dir = path.dirname(LIVE_CANVAS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { version: Date.now(), updatedAt: new Date().toISOString(), project };
  fs.writeFileSync(LIVE_CANVAS_FILE, JSON.stringify(payload), 'utf8');
  return payload.version;
}

function formatWiringGuide(project, catalog) {
  const byId = syncRegistry(catalog);
  const nodeById = new Map(project.nodes.map((n, idx) => [n.id, { node: n, idx }]));
  const diagnostics = RobotModel.diagnostics(project);
  const lines = [`# ${project.name} — Wiring Guide & BOM`, ''];

  lines.push('## Bill of Materials');
  const counts = new Map();
  for (const n of project.nodes) {
    const def = byId.get(n.type);
    const variant = n.pack && def?.variants?.find(v => v.id === n.pack);
    const key = `${n.type}:${n.pack || ''}`;
    if (!counts.has(key)) {
      counts.set(key, {
        qty: 0,
        name: variant?.name || def?.name || n.type,
        category: def?.category || 'Component',
        price: def?.productDetails?.price ? `$${def.productDetails.price}` : '—',
        url: def?.productDetails?.url || def?.source?.url || def?.sources?.[0]?.url || ''
      });
    }
    counts.get(key).qty++;
  }
  lines.push('| Qty | Component | Category | Est. Price | Reference |');
  lines.push('|---:|---|---|---|---|');
  for (const item of counts.values()) {
    lines.push(`| ${item.qty} | ${item.name} | ${item.category} | ${item.price} | ${item.url || '—'} |`);
  }

  lines.push('', '## Pin-to-Pin Connections');
  if (!project.wires.length) {
    lines.push('_No wires defined yet._');
  } else {
    lines.push('| # | From Component | From Pin | To Component | To Pin | Role |');
    lines.push('|---:|---|---|---|---|---|');
    project.wires.forEach((w, idx) => {
      const a = nodeById.get(w.from);
      const b = nodeById.get(w.to);
      if (!a || !b) return;
      const aPin = RobotModel.pins(project, a.node)[w.pin]?.name || String(w.pin);
      const bPin = RobotModel.pins(project, b.node)[w.toPin ?? 0]?.name || String(w.toPin ?? 0);
      const aLabel = `${byId.get(a.node.type)?.label || a.node.type} (#${a.idx})`;
      const bLabel = `${byId.get(b.node.type)?.label || b.node.type} (#${b.idx})`;
      const role = RobotModel.wireRole(project, w);
      lines.push(`| ${idx + 1} | ${aLabel} | \`${aPin}\` | ${bLabel} | \`${bPin}\` | ${role} |`);
    });
  }

  lines.push('', '## Hardware Safety Checks');
  if (!diagnostics.length) {
    lines.push('- All MCC wiring safety checks passed.');
  } else {
    for (const d of diagnostics) {
      lines.push(`- **[${d.severity.toUpperCase()}] ${d.title}:** ${d.detail}`);
    }
  }
  return lines.join('\n');
}

// Cached VM loader for real ESP8266 MicroPython simulation
let firmwareSourcesCache = null;
function loadFirmwareSources() {
  if (firmwareSourcesCache) return firmwareSourcesCache;
  const files = [
    'dist/vendor/esp8266/xtensa-esp8266.js',
    'dist/vendor/esp8266/rom-symbols.js',
    'dist/vendor/esp8266/rom8266.js',
    'dist/vendor/esp8266/firmware/micropython.js',
    'dist/firmware-engine.js'
  ];
  firmwareSourcesCache = files.map(rel => ({ rel, code: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
  return firmwareSourcesCache;
}

function simulateMicroPython({ code, adc = 0, gpioInputs = {}, runMs = 600 }) {
  const script = String(code || '').replace(/\r\n/g, '\n').trim();
  if (!script) throw new Error('code must be a non-empty MicroPython script.');
  const clampedMs = Math.max(50, Math.min(3000, Number(runMs) || 600));

  const ctx = vm.createContext({
    console, Uint8Array, Int32Array, Float32Array, Float64Array, ArrayBuffer,
    BigInt, Math, Number, String, Array, Object, Error, atob, btoa
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const src of loadFirmwareSources()) {
    vm.runInContext(src.code, ctx, { filename: src.rel });
  }
  const FirmwareEngine = vm.runInContext('FirmwareEngine', ctx);

  let bootLog = '';
  let runLog = '';
  let capturingRun = false;
  const machine = FirmwareEngine.create({ preset: 'micropython' }, b => {
    const ch = String.fromCharCode(b);
    if (capturingRun) {
      if (runLog.length < 16000) runLog += ch;
    } else {
      bootLog += ch;
    }
  });

  // Boot MicroPython to REPL
  for (let i = 0; i < 6000; i++) {
    machine.step(1024);
    machine.sys.addUs(200);
    if (bootLog.includes('>>> ')) break;
  }
  if (!bootLog.includes('>>> ')) {
    throw new Error('MicroPython did not reach REPL prompt.');
  }

  // Apply virtual ADC (0..1) and external GPIO inputs
  machine.adc(Math.max(0, Math.min(1, Number(adc) || 0)));
  let mask = 0;
  let value = 0;
  for (const [pinKey, lvl] of Object.entries(gpioInputs || {})) {
    const gpio = Number(pinKey);
    if (Number.isInteger(gpio) && gpio >= 0 && gpio <= 16) {
      mask |= 1 << gpio;
      if (lvl) value |= 1 << gpio;
    }
  }
  if (mask) machine.inputs(mask, value);

  // Send script via MicroPython paste mode
  capturingRun = true;
  machine.send('\x05' + script.replace(/\n/g, '\r') + '\r\x04');

  const startUs = machine.sys.getUs();
  const targetUs = startUs + clampedMs * 1000;
  const wallStart = Date.now();
  let steps = 0;
  while (machine.sys.getUs() < targetUs && steps < 4000 && Date.now() - wallStart < 8000) {
    machine.step(512);
    machine.sys.addUs(150);
    steps++;
  }

  const out = machine.outputs();
  const nodeMcuMap = [
    ['D0', 16], ['D1', 5], ['D2', 4], ['D3', 0], ['D4', 2],
    ['D5', 14], ['D6', 12], ['D7', 13], ['D8', 15]
  ];
  const pins = {};
  for (const [label, gpio] of nodeMcuMap) {
    const enabled = !!((out.enable >>> gpio) & 1);
    const high = !!(((out.out & out.enable) >>> gpio) & 1);
    const duty = Math.round((out.duty[gpio] ?? (high ? 1 : 0)) * 1000) / 1000;
    const freqHz = out.freq[gpio] ?? 0;
    const pulseUs = out.pulseUs[gpio] ?? 0;
    if (enabled || freqHz > 0) {
      pins[`${label} (GPIO${gpio})`] = { enabled, high, duty, freqHz, pulseUs };
    }
  }

  return {
    serialOutput: runLog.replace(/\r/g, ''),
    emulatedMs: Math.round((out.us - startUs) / 1000),
    instructions: out.instructions,
    adcInput: Math.max(0, Math.min(1, Number(adc) || 0)),
    activePins: pins
  };
}

const TOOLS = [
  {
    name: 'mcc_search_parts',
    description: 'Search MCC verified electronics component catalog (NodeMCU ESP8266, interactive sensors/actuators, and 350+ researched Adafruit parts) by keyword or category. Returns exact IDs and zero-based pin indices.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword (e.g. "servo", "esp8266", "buzzer", "potentiometer", "oled", "feather")' },
        category: { type: 'string', description: 'Optional category filter' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 15)' }
      }
    }
  },
  {
    name: 'mcc_get_part',
    description: 'Get full verified pinout, conductor groups, variants, wiring help, and datasheet links for a specific MCC component ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Component ID (e.g. "esp8266", "servo", "pushbutton", "potentiometer", "buzzer", "resistor")' }
      }
    }
  },
  {
    name: 'mcc_build_and_validate_circuit',
    description: 'Construct and deterministically validate a circuit using MCC RobotModel rules (pin compatibility, single-driver passive conductors, series cell safety, voltage diagnostics). Optionally save to MCC local library and push live to the open MCC blueprint canvas.',
    inputSchema: {
      type: 'object',
      required: ['components', 'wires'],
      properties: {
        name: { type: 'string', description: 'Project name (max 60 chars)' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string' },
              pack: { type: 'string' },
              pinDirections: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['pin', 'direction'],
                  properties: {
                    pin: { type: 'integer' },
                    direction: { type: 'string', enum: ['input', 'output'] }
                  }
                }
              },
              value: { type: 'number', description: 'Potentiometer initial 0..1 value' },
              ohms: { type: 'number', description: 'Resistor value in ohms' }
            }
          }
        },
        wires: {
          type: 'array',
          items: {
            type: 'object',
            required: ['aComponent', 'aPin', 'bComponent', 'bPin'],
            properties: {
              aComponent: { type: 'integer' },
              aPin: { type: 'integer' },
              bComponent: { type: 'integer' },
              bPin: { type: 'integer' }
            }
          }
        },
        micropythonScript: { type: 'string', description: 'Optional MicroPython script to attach to any NodeMCU ESP8266 in the circuit' },
        save: { type: 'boolean', description: 'Persist project to local MCC SQLite library' },
        pushToCanvas: { type: 'boolean', description: 'Push circuit live onto the open MCC browser blueprint canvas' }
      }
    }
  },
  {
    name: 'mcc_simulate_micropython',
    description: 'Execute MicroPython code on MCC real Xtensa ESP8266 emulator with virtual A0 ADC (0..1) and GPIO inputs. Returns UART0 serial output, active GPIO states, and measured FRC1 hardware PWM duty cycle, frequency (Hz), and pulse width (µs).',
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'MicroPython script to execute on ESP8266' },
        adc: { type: 'number', minimum: 0, maximum: 1, description: 'Analog input level on A0 (0.0 to 1.0 -> ADC 0..1024)' },
        gpioInputs: { type: 'object', description: 'Map of GPIO number string (e.g. "5") to 0 or 1' },
        runMs: { type: 'integer', minimum: 50, maximum: 3000, description: 'Emulated runtime in milliseconds (default 600)' }
      }
    }
  },
  {
    name: 'mcc_export_wiring_guide',
    description: 'Generate a printable Markdown Bill of Materials (BOM), pin-to-pin wiring table, and hardware safety checklist for a saved project ID or inline project JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'UUID of a saved local MCC project' },
        project: { type: 'object', description: 'Inline MCC project object (name, nodes, wires)' }
      }
    }
  },
  {
    name: 'mcc_list_projects',
    description: 'List saved circuits in the local MCC projects library.',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function callTool(name, args = {}) {
  const catalog = await loadCatalog();

  if (name === 'mcc_search_parts') {
    const q = String(args.query || '').trim().toLowerCase();
    const cat = String(args.category || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const matches = catalog.filter(def => {
      if (def.id === 'board' || def.enabled === false) return false;
      if (cat && !String(def.category || '').toLowerCase().includes(cat)) return false;
      if (!q) return true;
      const hay = `${def.id} ${def.name} ${def.label || ''} ${def.subtitle || ''} ${def.category || ''} ${(def.pins || []).map(p => p.name).join(' ')}`.toLowerCase();
      return q.split(/\s+/).every(tok => hay.includes(tok));
    }).slice(0, limit).map(def => ({
      id: def.id,
      name: def.name,
      category: def.category,
      simulated: def.renderer !== 'generic' || (Array.isArray(def.conductors) && def.conductors.length > 0),
      variants: (def.variants || []).map(v => ({ id: v.id, name: v.name, voltage: v.voltage })),
      pins: (def.pins || []).map((p, pin) => ({ pin, id: p.id, name: p.name, kind: p.kind, ...(p.gpio != null ? { gpio: p.gpio } : {}) }))
    }));
    return { totalCatalog: catalog.length, count: matches.length, parts: matches };
  }

  if (name === 'mcc_get_part') {
    const def = catalog.find(d => d.id === args.id);
    if (!def) throw new Error(`Part "${args.id}" not found in catalog.`);
    return {
      ...def,
      pins: def.pins.map((p, pin) => ({ pin, ...p }))
    };
  }

  if (name === 'mcc_build_and_validate_circuit') {
    const { project, diagnostics } = buildValidatedProject(args, catalog);
    const saved = args.save ? saveProjectLocal(project) : null;
    const liveVersion = args.pushToCanvas ? pushLiveCanvas(project) : null;
    return {
      valid: true,
      project,
      diagnostics,
      saved,
      pushedToCanvas: !!liveVersion,
      liveVersion,
      wiringGuide: formatWiringGuide(project, catalog)
    };
  }

  if (name === 'mcc_simulate_micropython') {
    return simulateMicroPython(args);
  }

  if (name === 'mcc_export_wiring_guide') {
    let project = args.project;
    if (!project && args.projectId) {
      const dbPath = process.env.LOCAL_COMPONENT_DB;
      if (!dbPath) throw new Error('LOCAL_COMPONENT_DB is not configured.');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT project FROM user_projects WHERE id = ?').get(String(args.projectId));
        if (!row) throw new Error(`Project "${args.projectId}" not found.`);
        project = JSON.parse(String(row.project));
      } finally {
        db.close();
      }
    }
    if (!project || !Array.isArray(project.nodes) || !Array.isArray(project.wires)) {
      throw new Error('Provide either a valid projectId or inline project object.');
    }
    return { markdown: formatWiringGuide(project, catalog) };
  }

  if (name === 'mcc_list_projects') {
    const dbPath = process.env.LOCAL_COMPONENT_DB;
    if (!dbPath) return { projects: [] };
    const db = new DatabaseSync(dbPath);
    try {
      ensureProjectsTable(db);
      const rows = db.prepare('SELECT id, name, updated_at AS updatedAt, project FROM user_projects ORDER BY updated_at DESC LIMIT 50').all();
      return {
        projects: rows.map(r => {
          const p = JSON.parse(String(r.project));
          return { id: r.id, name: r.name, updatedAt: r.updatedAt, nodes: p.nodes?.length || 0, wires: p.wires?.length || 0 };
        })
      };
    } finally {
      db.close();
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --- JSON-RPC 2.0 stdio transport (supports newline-delimited JSON and Content-Length framing) ---
let useContentLength = false;

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const bytes = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        }
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') {
      if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      return writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const output = await callTool(toolName, toolArgs);
        return writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }]
          }
        });
      } catch (err) {
        return writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
          }
        });
      }
    }
    if (!isNotification) {
      writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (!isNotification) {
      writeMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}

function startStdio() {
  let buffer = Buffer.alloc(0);

  function drain() {
    while (buffer.length > 0) {
      // Skip leading whitespace
      let start = 0;
      while (start < buffer.length && (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0d || buffer[start] === 0x0a)) start++;
      if (start > 0) buffer = buffer.subarray(start);
      if (!buffer.length) break;

      // Content-Length framing (LSP / legacy MCP style)
      if (buffer.subarray(0, 15).toString('ascii').toLowerCase().startsWith('content-length:')) {
        useContentLength = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/content-length:\s*(\d+)/i);
        if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const len = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) break;
        const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
        buffer = buffer.subarray(bodyStart + len);
        try { void handleRequest(JSON.parse(body)); } catch {}
        continue;
      }

      // Newline-delimited JSON (standard MCP stdio transport)
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) break;
      const line = buffer.subarray(0, nl).toString('utf8').trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      try { void handleRequest(JSON.parse(line)); } catch {}
    }
  }

  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  process.stdin.resume();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startStdio();

export { TOOLS, callTool, buildValidatedProject, simulateMicroPython, formatWiringGuide };
