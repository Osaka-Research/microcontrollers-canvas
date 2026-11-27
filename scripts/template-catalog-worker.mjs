#!/usr/bin/env node
/**
 * Continuous Gemini IRL circuit template worker for Microcontrollers Canvas.
 * Designs real-world electronics & robotics starter templates (RC car, drone,
 * obstacle-avoiding robot, pan-tilt gimbal, weather station, etc.) using ONLY
 * verified components from the local catalog, validates every connection with
 * RobotModel, lays out components cleanly without overlap, and saves verified
 * templates locally into SQLite (.research/adafruit/catalog.sqlite) + JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, renameSync, closeSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ComponentRegistry = require('../dist/component-registry.js');
const RobotModel = require('../dist/model.js');
const initialCatalog = require('./initial-component-catalog.cjs');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE = path.join(ROOT, '.research', 'adafruit');
export const DEFAULT_DB = path.join(ARCHIVE, 'catalog.sqlite');
export const DEFAULT_JSON = path.join(ROOT, '.research', 'local-templates.json');
export const DEFAULT_PROVIDER = 'gemini';
export const DEFAULT_MODEL = 'gemini-4-neon-medium';
export const DEFAULT_GEMINI_API_MODEL = 'gemini-2.5-flash';

export const TEMPLATE_IDEAS = [
  {
    id: 'rc-car-2wd',
    name: '2WD RC Car (Dual Motor Drive)',
    category: 'ROBOTICS',
    difficulty: 'Beginner',
    keywords: ['motor', 'driver', 'esp32', 'feather', 'pico', 'wifi', 'bluetooth', 'battery'],
    prompt: 'Build a real-world 2WD RC car drive circuit using a real microcontroller board from the catalog (such as an ESP32 Feather, Pico 2 W, or NodeMCU esp8266), a TB6612FNG dual H-bridge motor driver, two 6V gearmotors (left & right wheels), and a 4xAA NiMH battery pack (eneloop4 or pro4, NOT 9V) powering VM/VCC with shared ground and STBY/PWMA/AIN1/AIN2/PWMB/BIN1/BIN2 wired so both motors run when simulation starts.'
  },
  {
    id: 'obstacle-avoiding-rover',
    name: 'Obstacle-Avoiding Robot Rover',
    category: 'ROBOTICS',
    difficulty: 'Intermediate',
    keywords: ['ultrasonic', 'servo', 'motor', 'driver', 'battery', 'esp32', 'feather', 'pico'],
    prompt: 'Build a classic obstacle-avoiding robot rover combining a real microcontroller board from the catalog (prefer a generic Feather/ESP32/Pico board — if using esp8266, do NOT wire 5V HC-SR04 ECHO directly into a 3.3V esp8266 input), an HC-SR04 ultrasonic sensor mounted on an SG90 pan servo, a TB6612FNG motor driver, two gearmotors, and a 4xAA NiMH 4.8V battery pack with common ground.'
  },
  {
    id: 'mini-drone-flight-core',
    name: 'Mini Drone Flight Controller Core',
    category: 'AEROSPACE & DRONES',
    difficulty: 'Advanced',
    keywords: ['esp32', 'rp2040', 'feather', 'imu', 'gyro', 'accelerometer', 'gps', 'motor', 'driver', 'lipo', 'battery'],
    prompt: 'Build a beginner-friendly educational mini quadcopter / drone flight controller wiring diagram using an ESP32/RP2040/Feather flight controller, dual TB6612FNG motor drivers driving brushed drone motors, a GPS or IMU sensor breakout if available in the catalog, and a suitable power source with shared ground. Clearly explain in realWorldNotes that real drones need ESCs/high-discharge LiPo packs and closed-loop PID stabilization.'
  },
  {
    id: 'pan-tilt-camera-gimbal',
    name: 'Pan-Tilt Servo Gimbal',
    category: 'MECHATRONICS',
    difficulty: 'Beginner',
    keywords: ['servo', 'battery', 'esp8266', 'esp32', 'feather', 'pico'],
    prompt: 'Build a 2-axis pan-tilt servo gimbal using a real microcontroller board from the catalog (such as ESP32 Feather, Pico, or NodeMCU esp8266), two TowerPro SG90 servos (Pan and Tilt), and a 4xAA NiMH 4.8V battery pack (eneloop4) with shared ground.'
  },
  {
    id: 'smart-parking-sonar',
    name: 'Ultrasonic Parking Distance Sensor',
    category: 'SENSORS & IOT',
    difficulty: 'Beginner',
    keywords: ['ultrasonic', 'led', 'esp32', 'feather', 'pico', 'battery', 'display'],
    prompt: 'Build a garage parking distance indicator using a real microcontroller board from the catalog (use a Feather/ESP32/Pico board, NOT esp8266 directly on 5V ECHO), an HC-SR04 ultrasonic sensor, a 4xAA battery pack, and two status LEDs with shared ground.'
  },
  {
    id: 'robotic-arm-3dof',
    name: '3-DOF Robotic Arm Controller',
    category: 'ROBOTICS',
    difficulty: 'Intermediate',
    keywords: ['servo', 'battery', 'esp32', 'feather', 'pico', 'pwm', 'pca9685'],
    prompt: 'Build a 3-joint robotic arm (base, shoulder, gripper) using a real microcontroller board from the catalog (ESP32 Feather, Pico, or NodeMCU esp8266), three SG90 servos, a status LED, and a 4xAA eneloop pro 4.8V battery pack (pro4) with shared ground.'
  },
  {
    id: 'nodemcu-smart-door-latch',
    name: 'Wi-Fi Smart Door Latch (NodeMCU)',
    category: 'SMART HOME',
    difficulty: 'Beginner',
    keywords: ['esp8266', 'servo', 'led', 'battery', 'relay', 'lock'],
    prompt: 'Build an IoT smart door latch using a NodeMCU ESP8266 (Blink firmware on D4/GPIO2), an SG90 latch servo powered by a 4xAA eneloop4 4.8V pack, a status LED, and common ground connecting NodeMCU GND, battery negative, servo GND, and LED cathode.'
  },
  {
    id: 'smart-traffic-controller',
    name: '3-Light Traffic Signal Controller',
    category: 'BASICS',
    difficulty: 'Beginner',
    keywords: ['led', 'esp32', 'feather', 'pico', 'esp8266', 'battery'],
    prompt: 'Build a 3-LED traffic light controller using a real microcontroller board from the catalog (such as ESP32 Feather, Pico 2 W, or NodeMCU esp8266) driving three LEDs, plus a shared ground connecting all three LED cathodes to the controller GND.'
  },
  {
    id: 'dual-cell-series-flashlight',
    name: 'Dual-Cell Series Power & Indicator',
    category: 'POWER & BASICS',
    difficulty: 'Beginner',
    keywords: ['battery', 'cell', 'cr2032', 'led', 'esp32', 'feather', 'esp8266'],
    prompt: 'Build an educational series battery pack circuit connecting two identical 2xAA eneloop NiMH packs (eneloop2, 2.4V each -> 4.8V series) in series (Cell 1 + to Cell 2 -) powering an SG90 servo controlled by a real microcontroller board (ESP32 Feather or NodeMCU esp8266) with shared ground.'
  },
  {
    id: 'gps-telemetry-tracker',
    name: 'Portable GPS Telemetry Tracker',
    category: 'SENSORS & IOT',
    difficulty: 'Intermediate',
    keywords: ['gps', 'esp32', 'feather', 'pico', 'oled', 'lipo', 'battery', 'led'],
    prompt: 'Build a portable GPS telemetry tracker using a real microcontroller board from the catalog (such as ESP32/Feather/Pico or NodeMCU), a GPS breakout from the catalog if available (like Adafruit Ultimate GPS), a status LED, and a suitable battery pack with shared ground.'
  },
  {
    id: 'weather-station-node',
    name: 'IoT Weather Station Sensor Node',
    category: 'SENSORS & IOT',
    difficulty: 'Intermediate',
    keywords: ['bme280', 'bme680', 'dht', 'temp', 'humidity', 'pressure', 'sensor', 'oled', 'tft', 'esp32', 'feather', 'pico', 'battery'],
    prompt: 'Build an IoT weather station using a modern microcontroller board from the catalog (ESP32/Feather/Pico/NodeMCU), an environmental sensor breakout (temperature/humidity/pressure if present in catalog), an optional display breakout, and power supply with shared ground.'
  },
  {
    id: 'line-following-bot',
    name: 'Line-Following 2WD Robot',
    category: 'ROBOTICS',
    difficulty: 'Intermediate',
    keywords: ['motor', 'driver', 'ir', 'reflectance', 'optical', 'sensor', 'battery', 'esp32', 'feather', 'pico'],
    prompt: 'Build a differential-drive line-following robot with a real microcontroller board from the catalog (ESP32 Feather, Pico, or NodeMCU), TB6612FNG dual motor driver, left and right 6V gearmotors, an IR/optical sensor breakout from the catalog if available (or status LEDs indicating left/right turn), and 4xAA NiMH battery supply with common ground.'
  },
  {
    id: 'portable-synth-audio-badge',
    name: 'Portable Audio & LED Synth Badge',
    category: 'AUDIO & WEARABLES',
    difficulty: 'Intermediate',
    keywords: ['audio', 'speaker', 'i2s', 'amp', 'neopixel', 'led', 'feather', 'pico', 'esp32', 'battery'],
    prompt: 'Build a portable interactive audio/LED badge using a real microcontroller from the catalog, an audio/speaker breakout from the catalog if available, status LEDs, and battery power with common ground.'
  },
  {
    id: 'automated-greenhouse-controller',
    name: 'Automated Greenhouse Controller',
    category: 'SMART HOME',
    difficulty: 'Intermediate',
    keywords: ['soil', 'moisture', 'temp', 'humidity', 'relay', 'servo', 'motor', 'driver', 'pump', 'battery', 'esp32', 'feather'],
    prompt: 'Build an automated greenhouse vent & pump controller using a real microcontroller board from the catalog, a servo for vent opening, a TB6612FNG driver + motor representing a small water pump, an environmental sensor if available in the catalog, and a 4xAA NiMH supply with shared ground.'
  },
  {
    id: 'autonomous-turret-tracker',
    name: 'Ultrasonic Radar Scanner',
    category: 'ROBOTICS',
    difficulty: 'Intermediate',
    keywords: ['ultrasonic', 'servo', 'led', 'esp32', 'feather', 'pico', 'battery', 'display'],
    prompt: 'Build a sweeping ultrasonic radar scanner using a real microcontroller board from the catalog (Feather/ESP32/Pico — not esp8266 directly on 5V ECHO), an SG90 sweep servo, an HC-SR04 ultrasonic module, a target-alert LED, and a 4xAA 4.8V NiMH pack with shared ground.'
  }
];

export const TEMPLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    realWorldNotes: { type: 'string' },
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          pack: { type: 'string' },
          modes: { type: 'array', items: { type: 'string', enum: ['low', 'high', 'blink'] } },
          period: { type: 'number' },
          distanceCm: { type: 'number' },
          pinDirections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pin: { type: 'integer', minimum: 0 },
                direction: { type: 'string', enum: ['input', 'output'] }
              },
              required: ['pin', 'direction']
            }
          }
        },
        required: ['type', 'pack', 'modes', 'period', 'distanceCm', 'pinDirections']
      }
    },
    wires: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          aComponent: { type: 'integer', minimum: 0 },
          aPin: { type: 'integer', minimum: 0 },
          bComponent: { type: 'integer', minimum: 0 },
          bPin: { type: 'integer', minimum: 0 }
        },
        required: ['aComponent', 'aPin', 'bComponent', 'bPin']
      }
    }
  },
  required: ['name', 'description', 'realWorldNotes', 'components', 'wires']
};

export function ensureTemplatesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL DEFAULT 'Beginner',
      description TEXT NOT NULL DEFAULT '',
      real_world_notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
      model TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL CHECK (json_valid(project)),
      updated_at TEXT NOT NULL
    );
  `);
}

export function loadLocalCatalog(db) {
  const byId = new Map(initialCatalog.filter(def => def.enabled !== false).map(def => [def.id, structuredClone(def)]));
  try {
    const rows = db.prepare(`
      SELECT definition FROM component_catalog
      WHERE status IN ('draft', 'published')
        AND json_array_length(json_extract(definition, '$.pins')) > 0
        AND json_extract(definition, '$.needsPinoutResearch') = 0
    `).all();
    for (const row of rows) {
      const def = JSON.parse(row.definition);
      if (def?.id && Array.isArray(def.pins) && def.pins.length > 0 && ComponentRegistry.validConductors(def)) {
        def.enabled = true;
        byId.set(def.id, def);
      }
    }
  } catch { /* component_catalog may not exist in standalone template test DBs */ }
  return [...byId.values()];
}

export function selectRelevantCatalog(catalog, keywords = [], maxExtras = 14) {
  const coreIds = new Set(initialCatalog.filter(def => def.enabled !== false).map(def => def.id));
  const core = catalog.filter(def => coreIds.has(def.id));
  const lowered = keywords.map(k => k.toLowerCase());
  const extras = catalog
    .filter(def => !coreIds.has(def.id) && def.pins.length > 0 && def.pins.length <= 44)
    .map(def => {
      const hay = `${def.id} ${def.name} ${def.category || ''} ${def.help || ''}`.toLowerCase();
      const score = lowered.reduce((sum, kw) => sum + (hay.includes(kw) ? 1 : 0), 0);
      return { def, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.def.pins.length - b.def.pins.length)
    .slice(0, maxExtras)
    .map(item => item.def);
  return [...core, ...extras];
}

export function materializeProject(plan, catalog) {
  ComponentRegistry.replace(catalog);
  if (!plan || !Array.isArray(plan.components) || !Array.isArray(plan.wires)) {
    throw new Error('Template plan must include components and wires arrays.');
  }
  if (plan.components.length === 0 || plan.components.length > 16) {
    throw new Error('Template must contain between 1 and 16 components.');
  }
  if (plan.wires.length === 0 || plan.wires.length > 60) {
    throw new Error('Template must contain between 1 and 60 wires.');
  }

  const colY = [80, 80, 80];
  const colX = [80, 360, 660];
  const roleColumn = type => {
    if (['mcu', 'esp8266', 'battery'].includes(type)) return 0;
    const def = ComponentRegistry.get(type);
    if (type === 'motorDriver' || def?.conductors?.length) return 1;
    if (def?.category === 'MICROCONTROLLERS' || def?.category === 'POWER SUPPLY') return 0;
    return 2;
  };
  const estHeight = type => {
    const def = ComponentRegistry.get(type);
    if (type === 'esp8266') return 360;
    if (type === 'motorDriver') return 460;
    return Math.max(190, 115 + (def?.pins?.length || 4) * 30);
  };

  const nodes = plan.components.map((item, idx) => {
    const def = ComponentRegistry.get(item?.type);
    if (!def) throw new Error(`Unknown component type "${item?.type}" at index ${idx}.`);
    const col = roleColumn(def.id);
    const x = Math.round(colX[col] / 10) * 10;
    const y = Math.round(colY[col] / 10) * 10;
    colY[col] += estHeight(def.id) + 40;

    const pinCount = def.id === 'esp8266' ? RobotModel.espPins.length : def.renderer === 'generic' ? def.pins.length : 4;
    const rawModes = Array.isArray(item.modes) ? item.modes : [];
    const modes = Array.from({ length: pinCount }, (_, i) =>
      ['low', 'high', 'blink'].includes(rawModes[i]) ? rawModes[i] : 'low'
    );
    const period = Number.isFinite(item.period) && item.period >= 0.2 && item.period <= 5 ? item.period : 1;
    const node = { id: `n${idx + 1}`, type: def.id, x, y, modes, period };

    if (def.variants?.length) {
      node.pack = def.variants.some(v => v.id === item.pack) ? item.pack : def.variants[0].id;
    }
    if (def.id === 'ultrasonic' && Number.isFinite(item.distanceCm) && item.distanceCm >= 2 && item.distanceCm <= 400) {
      node.distanceCm = Math.round(item.distanceCm);
    }
    if (def.id === 'esp8266') {
      node.firmware = { preset: 'blink' };
    }
    if (def.pins.some(p => p.kind === 'bidirectional') || (def.id === 'esp8266' && item.pinDirections?.length)) {
      const dirs = def.pins.map(p => (p.kind === 'bidirectional' ? 'input' : p.kind));
      for (const entry of item.pinDirections || []) {
        if (!entry || !Number.isInteger(entry.pin) || entry.pin < 0 || entry.pin >= def.pins.length) continue;
        const canFlip = def.pins[entry.pin].kind === 'bidirectional' || (def.id === 'esp8266' && def.pins[entry.pin].gpio != null);
        if (canFlip && ['input', 'output'].includes(entry.direction)) dirs[entry.pin] = entry.direction;
      }
      node.pinDirections = dirs;
    }
    return node;
  });

  const project = {
    name: String(plan.name || 'Circuit template').trim().slice(0, 60) || 'Circuit template',
    boards: [],
    nodes,
    wires: []
  };

  for (const w of plan.wires) {
    if (!w || ![w.aComponent, w.aPin, w.bComponent, w.bPin].every(Number.isInteger)) {
      throw new Error('Wire entry has non-integer indices.');
    }
    if (w.aComponent < 0 || w.aComponent >= nodes.length || w.bComponent < 0 || w.bComponent >= nodes.length) {
      throw new Error(`Wire references out-of-range component (${w.aComponent} -> ${w.bComponent}).`);
    }
    const wire = RobotModel.connection(
      project,
      { id: nodes[w.aComponent].id, pin: w.aPin },
      { id: nodes[w.bComponent].id, pin: w.bPin }
    );
    if (!wire) {
      const a = nodes[w.aComponent], b = nodes[w.bComponent];
      const aPin = RobotModel.pins(project, a)[w.aPin]?.name || w.aPin;
      const bPin = RobotModel.pins(project, b)[w.bPin]?.name || w.bPin;
      throw new Error(`Incompatible wire between ${a.type}[${w.aComponent}].${aPin} and ${b.type}[${w.bComponent}].${bPin}.`);
    }
    const key = RobotModel.attachmentKey(project, wire);
    if (!project.wires.some(existing => RobotModel.attachmentKey(project, existing) === key)) {
      project.wires.push(wire);
    }
  }

  if (!project.wires.length) throw new Error('Template has no valid wires.');
  if (!RobotModel.valid(project)) throw new Error('Generated project failed RobotModel.valid() check.');

  const warnings = RobotModel.diagnostics(project).filter(d => d.severity === 'warning');
  if (warnings.length) {
    throw new Error(`Hardware safety warning(s): ${warnings.map(w => w.title).join('; ')}`);
  }
  return project;
}

export function buildTemplatePrompt(idea, catalogSubset, previousError = '') {
  const catalogContext = catalogSubset.map(def => ({
    type: def.id,
    name: def.name,
    variants: def.variants?.map(v => ({ id: v.id, voltage: v.voltage })) || [],
    pins: def.pins.map((p, idx) => ({ pin: idx, name: p.name, kind: p.kind })),
    ...(def.conductors?.length ? { conductors: def.conductors } : {})
  }));
  return `Design a complete, working, beginner-friendly real-world electronics circuit template for Microcontrollers Canvas (MCC).

Template goal: ${idea.name} (${idea.category}, ${idea.difficulty})
Instructions: ${idea.prompt}

Strict wiring & safety rules:
1. Use ONLY component types, variant pack IDs, and 0-based pin indices from the catalog JSON below.
2. Wiring rules:
   - output -> input or drive-input
   - power -> power-input or drive-input (NEVER connect a battery directly to an LED!)
   - ground / ground-input / passive-ground can connect together to form a common ground net!
   - 2-pin cells/batteries can connect in series: Cell A (+) [power] -> Cell B (-) [ground].
   - For bidirectional pins (or NodeMCU GPIO inputs), set pinDirections explicitly.
3. Safety rules (MUST have zero warnings):
   - NEVER drive a DC gearmotor directly from MCU/NodeMCU GPIO — always use motorDriver (TB6612FNG).
   - NEVER use nineVolt battery on a servo or motorDriver VM — use eneloop4 or pro4 (4.8 V).
   - NEVER connect 5V HC-SR04 ECHO directly to a 3.3V NodeMCU input (use virtual mcu for HC-SR04 templates).
   - Always connect shared ground to every servo, motorDriver, ultrasonic, and LED cathode.
   - For mcu nodes, set modes (array of 4: 'low'|'high'|'blink') so the circuit visibly comes alive when the user presses Run! (For TB6612FNG, make sure STBY, PWMA/PWMB, and one direction pin are HIGH/blink, plus VM, VCC, and GND connected.)
4. Set pack to "" for non-battery parts, distanceCm to 40 (or a sensible number 2–400 for ultrasonic), period to 1, pinDirections to [] when not needed.
5. Speed rule: Do NOT call any tools (no run_command, no read_file, no search_web). Everything you need is in the catalog below. Return ONLY the structured JSON matching the schema.${previousError ? `\n\nYour previous attempt failed validation with this error — FIX IT:\n${previousError}` : ''}

Available catalog:
${JSON.stringify(catalogContext)}`;
}

export function parseAgyOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const envelope = JSON.parse(lines[i]);
      if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
      if (typeof envelope.response === 'string' && envelope.response.trim()) {
        const match = envelope.response.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      }
      if (envelope.components && envelope.wires) return envelope;
    } catch { /* try earlier line */ }
  }
  throw new Error('Gemini (agy) output did not contain structured template JSON.');
}

export async function generateWithGemini({ prompt, model = DEFAULT_MODEL, agyBin = 'agy', timeoutMs = 120_000, rootDir = ROOT }) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'mcc-tpl-'));
  const schemaPath = path.join(workDir, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(TEMPLATE_SCHEMA));
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
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Gemini (agy) timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 15_000);
      child.stdout.on('data', chunk => { out += chunk.toString(); });
      child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-1200); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`agy exited with code ${code}${err ? `: ${err.trim()}` : ''}`));
      });
    });
    return parseAgyOutput(stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function generateWithGeminiApi({ prompt, model = DEFAULT_GEMINI_API_MODEL, apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, timeoutMs = 90_000, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is required for --provider gemini-api.');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: TEMPLATE_SCHEMA }
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Gemini API failed (${response.status})`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini API returned an empty template response.');
  return JSON.parse(text);
}

export function saveTemplate(db, record, jsonMirrorPath = DEFAULT_JSON) {
  ensureTemplatesTable(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_templates (id, name, category, difficulty, description, real_world_notes, status, model, project, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      difficulty = excluded.difficulty,
      description = excluded.description,
      real_world_notes = excluded.real_world_notes,
      status = excluded.status,
      model = excluded.model,
      project = excluded.project,
      updated_at = excluded.updated_at
  `).run(
    record.id, record.name, record.category, record.difficulty,
    record.description, record.realWorldNotes, record.status,
    record.model, JSON.stringify(record.project), now
  );
  if (jsonMirrorPath) {
    const ready = db.prepare(`
      SELECT id, name, category, difficulty, description, real_world_notes AS realWorldNotes, model, project, updated_at AS updatedAt
      FROM project_templates WHERE status = 'ready' ORDER BY category, name
    `).all().map(row => ({ ...row, project: JSON.parse(row.project) }));
    mkdirSync(path.dirname(jsonMirrorPath), { recursive: true });
    const tmp = `${jsonMirrorPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(ready, null, 2)}\n`);
    renameSync(tmp, jsonMirrorPath);
  }
}

export function getTemplateStats(db) {
  ensureTemplatesTable(db);
  const rows = db.prepare('SELECT id, status FROM project_templates').all();
  const ready = rows.filter(r => r.status === 'ready').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const doneIds = new Set(rows.filter(r => r.status === 'ready').map(r => r.id));
  const pendingBacklog = TEMPLATE_IDEAS.filter(idea => !doneIds.has(idea.id)).length;
  return { totalBacklog: TEMPLATE_IDEAS.length, ready, failed, pendingBacklog };
}

function acquireLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const existingPid = Number(readFileSync(lockPath, 'utf8').trim());
      if (existingPid && existingPid !== process.pid) {
        process.kill(existingPid, 0);
        throw new Error(`Another template worker is already running (PID ${existingPid}).`);
      }
    } catch (error) {
      if (error.code !== 'ESRCH' && /already running/.test(error.message)) throw error;
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

export async function runTemplateWorker(options = {}) {
  const {
    dbPath = DEFAULT_DB,
    jsonMirrorPath = DEFAULT_JSON,
    rootDir = ROOT,
    provider = DEFAULT_PROVIDER,
    model = provider === 'gemini-api' ? DEFAULT_GEMINI_API_MODEL : DEFAULT_MODEL,
    agyBin = 'agy',
    limit = 0,
    delayMs = 2000,
    timeoutMs = 120_000,
    templateId = null,
    customIdea = null,
    retryFailed = false,
    generator = null,
    signal = null,
    log = console.log
  } = options;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  ensureTemplatesTable(db);

  try {
    const existing = new Map(db.prepare('SELECT id, status FROM project_templates').all().map(r => [r.id, r.status]));
    const ideas = customIdea
      ? [{
          id: customIdea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `custom-${Date.now()}`,
          name: customIdea.slice(0, 60),
          category: 'CUSTOM',
          difficulty: 'Intermediate',
          keywords: customIdea.toLowerCase().split(/\W+/).filter(w => w.length > 2),
          prompt: `Build a real-world working circuit for: ${customIdea}`
        }]
      : TEMPLATE_IDEAS.filter(idea => {
          if (templateId) return idea.id === templateId;
          const st = existing.get(idea.id);
          if (st === 'ready') return false;
          if (st === 'failed' && !retryFailed) return false;
          return true;
        });

    if (!ideas.length) {
      log('All template ideas are already built.');
      return { processed: 0, ready: 0, failed: 0 };
    }

    const runGen = generator || (provider === 'gemini-api'
      ? prompt => generateWithGeminiApi({ prompt, model, timeoutMs })
      : prompt => generateWithGemini({ prompt, model, agyBin, timeoutMs, rootDir }));

    const stats = { processed: 0, ready: 0, failed: 0 };
    for (const idea of ideas) {
      if (signal?.aborted) break;
      if (limit > 0 && stats.processed >= limit) break;
      const fullCatalog = loadLocalCatalog(db);
      const subset = selectRelevantCatalog(fullCatalog, idea.keywords);
      log(`[template] ${idea.id}: ${idea.name} (${subset.length} catalog parts in context)`);

      let lastError = '';
      let saved = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted) break;
        try {
          const prompt = buildTemplatePrompt(idea, subset, lastError);
          const plan = await runGen(prompt);
          const project = materializeProject(plan, fullCatalog);
          saveTemplate(db, {
            id: idea.id,
            name: project.name,
            category: idea.category,
            difficulty: idea.difficulty,
            description: String(plan.description || '').slice(0, 500),
            realWorldNotes: String(plan.realWorldNotes || '').slice(0, 800),
            status: 'ready',
            model,
            project
          }, jsonMirrorPath);
          stats.processed++;
          stats.ready++;
          saved = true;
          log(`[ready] ${idea.id}: ${project.nodes.length} parts, ${project.wires.length} wires`);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          log(`[retry ${attempt}/2] ${idea.id}: ${lastError}`);
        }
      }

      if (!saved && !signal?.aborted) {
        saveTemplate(db, {
          id: idea.id,
          name: idea.name,
          category: idea.category,
          difficulty: idea.difficulty,
          description: lastError.slice(0, 500),
          realWorldNotes: '',
          status: 'failed',
          model,
          project: { name: idea.name, boards: [], nodes: [], wires: [] }
        }, jsonMirrorPath);
        stats.processed++;
        stats.failed++;
        log(`[failed] ${idea.id}: ${lastError}`);
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
  const opts = {
    provider: DEFAULT_PROVIDER,
    model: null,
    agyBin: 'agy',
    limit: 0,
    delayMs: 2000,
    timeoutMs: 120_000,
    templateId: null,
    customIdea: null,
    retryFailed: false,
    statusOnly: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status') opts.statusOnly = true;
    else if (arg === '--retry-failed') opts.retryFailed = true;
    else if (arg === '--provider') opts.provider = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--agy') opts.agyBin = argv[++i];
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--delay-ms') opts.delayMs = Number(argv[++i]);
    else if (arg === '--timeout-s') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg === '--id') opts.templateId = String(argv[++i]);
    else if (arg === '--idea') opts.customIdea = String(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/template-catalog-worker.mjs [options]
  --status                      Print template counts and exit
  --provider gemini|gemini-api  AI backend (default: gemini via agy CLI)
  --model <name>                Model slug (default: ${DEFAULT_MODEL})
  --limit <N>                   Max templates to generate (0 = all pending)
  --id <slug>                   Generate a specific backlog template (e.g. rc-car-2wd)
  --idea "<description>"        Generate a custom IRL application template
  --retry-failed                Retry previously failed templates
  --delay-ms <ms>               Delay between templates (default: 2000)
  --timeout-s <sec>             Per-template timeout in seconds (default: 120)`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!['gemini', 'gemini-api'].includes(opts.provider)) throw new Error('Provider must be "gemini" or "gemini-api".');
  if (!opts.model) opts.model = opts.provider === 'gemini-api' ? DEFAULT_GEMINI_API_MODEL : DEFAULT_MODEL;
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.statusOnly) {
      const db = new DatabaseSync(DEFAULT_DB);
      try {
        console.log(JSON.stringify(getTemplateStats(db), null, 2));
      } finally {
        db.close();
      }
      process.exit(0);
    }
    const releaseLock = acquireLock(path.join(ARCHIVE, 'template-worker.lock'));
    const controller = new AbortController();
    const stop = () => { console.log('Stopping template worker…'); controller.abort(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      const result = await runTemplateWorker({ ...opts, signal: controller.signal });
      console.log(`Template worker finished: ${JSON.stringify(result)}`);
    } finally {
      releaseLock();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
