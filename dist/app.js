// Generated from src/app/*.js via "npm run build". Edit files in src/app/ instead.
'use strict';

/* === src/app/state.js === */
// State, persistence (with legacy robot-canvas-v1 migration), and shared helpers.
const STORAGE_KEY = 'mcc-project-v1';
const LEGACY_STORAGE_KEY = 'robot-canvas-v1';

const $ = s => document.querySelector(s);

function catalogLabel(type) {
  const def = ComponentRegistry.get(type);
  return def?.label || def?.name || 'Component';
}

function batteryInfo(n) {
  const variants = ComponentRegistry.variants('battery');
  return variants.find(pack => pack.id === n.pack) || variants.find(pack => pack.id === 'eneloop4') || variants[0] || { name: 'Battery pack' };
}

const componentLabel = n => n.type === 'battery' ? batteryInfo(n).name : catalogLabel(n.type);

let state = { name: 'Untitled project', nodes: [], wires: [] };
let pendingRestore = null;
let selected = null;
let selectedWire = null;
let contextDeleteMode = null;
let contextComponentId = null;
let pending = null;
let running = false;
let started = false;
let elapsed = 0;
let last = 0;
let pan = { x: 0, y: 0 };
let zoom = 1;
let history = [];
let redoHistory = [];
let rafId = 0;
let currentProjectId = null;

const viewport = $('#viewport');
const world = $('#world');
const uid = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isController = n => n.type === 'mcu' || n.type === 'board' || n.type === 'esp8266';
const boardFor = n => RobotModel.board(state, n);
const nodeName = n => n.type === 'board' ? boardFor(n).name : catalogLabel(n.type);
const pinName = (n, p) => RobotModel.pins(state, n)[p]?.name || 'Pin';

function valid(s) {
  return RobotModel.valid(s);
}

function isVisualOnlyPart(def) {
  if (!def || def.renderer !== 'generic') return false;
  if (def.behavior === 'none') return true;
  return !def.behavior && !(Array.isArray(def.conductors) && def.conductors.length > 0);
}

function migrateProject(s) {
  if (!s || !Array.isArray(s.nodes)) return s;
  for (const n of s.nodes) {
    if (n?.type !== 'esp8266' || !Array.isArray(n.modes)) continue;
    const oldCount = n.modes.length;
    if (oldCount < RobotModel.espPins.length) {
      n.modes = [...n.modes, ...Array(RobotModel.espPins.length - oldCount).fill('low')];
    }
    if (Array.isArray(n.pinDirections) && n.pinDirections.length < RobotModel.espPins.length) {
      const old = n.pinDirections;
      n.pinDirections = RobotModel.espPins.map((p, i) => i < old.length ? (old[i] || p.kind) : p.kind);
    }
  }
  return s;
}

function readStoredProjectRaw() {
  try {
    return localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredProject(projectObj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projectObj));
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}
}

try {
  const raw = readStoredProjectRaw();
  const s = raw ? migrateProject(JSON.parse(raw)) : null;
  if (valid(s)) state = s;
  else if (s?.nodes?.some?.(n => n && typeof n.type === 'string' && !ComponentRegistry.get(n.type))) pendingRestore = s;
} catch {}
state.boards ??= [];

function save() {
  if (pendingRestore) {
    $('#saved').textContent = 'Waiting for saved project parts';
    return;
  }
  try {
    writeStoredProject(state);
    $('#saved').textContent = 'Saved locally';
  } catch {
    $('#saved').textContent = 'Not saved — export your project';
    toast('Browser storage is full or unavailable. Export your project to keep changes.');
  }
}

function snapshot() {
  history.push(JSON.stringify(state));
  redoHistory = [];
  if (history.length > 40) history.shift();
}

let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200);
}

function signal(n, p) {
  return RobotModel.output(state, n, p, started, elapsed, window.Firmware?.read);
}

function input(n, p = 0) {
  return RobotModel.input(state, n, p, started, elapsed, window.Firmware?.read);
}

/* === src/app/render.js === */
// Canvas node, wire, and live signal rendering.
function boardHTML(n) {
  const b = boardFor(n);
  return `<div class="node board ${n.id === selected ? 'selected' : ''}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;width:280px"><div class="node-header">${esc(b.name)}<span class="node-label">CUSTOM</span></div><div class="board-face" style="aspect-ratio:${b.width}/${b.height}"><img src="${esc(b.image)}" alt="${esc(b.name)}" draggable="false">${b.pins.map((p, i) => `<button class="pin board-pin ${esc(p.kind)} ${pending?.id === n.id && Number(pending.pin) === i ? 'pending' : ''}" data-pin="${i}" style="left:${p.x * 100}%;top:${p.y * 100}%" aria-label="Connect ${esc(p.name)} (${esc(p.kind)})" title="${esc(p.name)} · ${esc(p.kind)}"><span>${esc(p.name)}</span></button>`).join('')}</div></div>`;
}

function componentArtHTML(def, assetUrl, fallbackHTML) {
  if (!assetUrl) return fallbackHTML;
  return `<button type="button" class="component-photo-open" aria-label="Expand photo of ${esc(def?.name || 'component')}"><img class="generic-image" src="${esc(assetUrl)}" alt="${esc(def?.visual?.alt || def?.name || 'Component')}" draggable="false"></button>`;
}

function genericPeripheralHTML(n, def) {
  const visual = def.visual || {};
  const pins = RobotModel.pins(state, n);
  const art = visual.assetUrl
    ? `<button type="button" class="component-photo-open" aria-label="Expand photo of ${esc(def.name)}"><img class="generic-image" src="${esc(visual.assetUrl)}" alt="${esc(visual.alt || def.name)}" draggable="false"></button>`
    : `<span class="generic-symbol">${esc(visual.symbol || def.icon || '▦')}</span>`;
  const badge = isVisualOnlyPart(def)
    ? '<div class="visual-only-badge" title="Wiring &amp; pinout reference only; internal behavior is not simulated">VISUAL ONLY · NOT SIMULATED</div>'
    : '';
  const rows = pins.map((p, i) => `<div class="pin-row generic-pin-row"><button class="pin generic-terminal ${RobotModel.sourceKind(p.kind) ? '' : 'input'} ${p.kind === 'reserved' ? 'reserved' : ''}" data-pin="${i}" ${p.kind === 'reserved' ? 'disabled' : ''} aria-label="Connect ${esc(p.name)} (${esc(p.kind)})" title="Connect ${esc(p.name)} · ${esc(p.kind)}"><span class="connection-dot" aria-hidden="true"></span><span>${esc(p.name)}</span><small>${esc(p.kind)}</small></button></div>`).join('');
  return `<div class="node-body generic-art ${esc(visual.className || '')}">${art}</div>${badge}${rows}`;
}

function peripheralHTML(n) {
  const definition = ComponentRegistry.get(n.type);
  if (definition?.renderer === 'generic') return genericPeripheralHTML(n, definition);
  const photoUrl = definition?.visual?.assetUrl;
  if (n.type === 'motorDriver') {
    return `${photoUrl ? `<div class="node-body generic-art">${componentArtHTML(definition, photoUrl, '')}</div>` : ''}<div class="driver-caption">DUAL H-BRIDGE · 2 MOTORS</div>${RobotModel.pins(state, n).map((p, i) => `<div class="pin-row driver-pin-row"><button class="pin ${p.kind === 'input' ? 'input' : ''}" data-pin="${i}" aria-label="${esc(p.name)} (${esc(p.kind)})" title="${esc(p.name)} · ${esc(p.kind)}"></button><span>${esc(p.name)}</span><small>${p.kind === 'input' ? 'CONTROL' : p.kind === 'output' ? 'MOTOR OUT' : p.kind === 'power-input' ? 'SUPPLY' : 'GROUND'}</small></div>`).join('')}`;
  }
  if (n.type === 'ultrasonic') {
    return `<div class="node-body ${photoUrl ? 'generic-art' : 'sonar-art'}">${componentArtHTML(definition, photoUrl, '<span>◉</span><span>◉</span>')}</div>${RobotModel.pins(state, n).map((p, i) => `<div class="pin-row component-pin-row"><button class="pin ${p.kind === 'input' ? 'input' : ''}" data-pin="${i}" aria-label="${esc(p.name)}"></button><span>${esc(p.name)}</span><span></span></div>`).join('')}`;
  }
  if (n.type === 'battery') {
    const pack = batteryInfo(n);
    const packPhoto = pack.assetUrl || photoUrl;
    return `<div class="node-body ${packPhoto ? 'generic-art' : ''}">${componentArtHTML(definition, packPhoto, `<span class="battery-art ${n.pack === 'nineVolt' ? 'battery-9v' : ''}"><i></i><b>${esc(pack.cells)}</b></span>`)}</div><div class="pin-row battery-pin-row"><span>${esc(pack.positive || 'V+ · POSITIVE')}</span><button class="pin" data-pin="0" aria-label="Battery positive power output"></button></div><div class="pin-row battery-pin-row"><span>${esc(pack.negative || 'GND · NEGATIVE')}</span><button class="pin" data-pin="1" aria-label="Battery ground output"></button></div><small class="battery-rating">${esc(pack.voltage)} · ${esc(pack.capacity)}</small>`;
  }
  if (n.type === 'pushbutton') {
    const active = !!(n.pressed || n.latched);
    return `<div class="node-body interactive-body"><button type="button" class="tactile-cap ${active ? 'pressed' : ''}" data-pushbutton="${esc(n.id)}" aria-pressed="${active}" title="Hold to press button"><span>${active ? 'HIGH' : 'PRESS'}</span></button></div><div class="pin-row battery-pin-row"><span>OUT <small>DIGITAL</small></span><button class="pin" data-pin="0" aria-label="Pushbutton digital output"></button></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="1" aria-label="Pushbutton ground"></button><span>GND</span><span class="output-state">${active ? 'PRESSED' : 'OPEN'}</span></div>`;
  }
  if (n.type === 'potentiometer') {
    const val = Math.max(0, Math.min(1, n.value ?? 0.5));
    const pct = Math.round(val * 100);
    const deg = Math.round(-135 + val * 270);
    return `<div class="node-body interactive-body pot-body"><div class="pot-dial" style="--dial-deg:${deg}deg" aria-hidden="true"><i></i></div><input type="range" class="pot-slider" data-pot="${esc(n.id)}" min="0" max="100" step="1" value="${pct}" aria-label="Potentiometer position"><small class="pot-readout">${pct}% · ${(val * 3.3).toFixed(2)}V</small></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="0" aria-label="Potentiometer VCC"></button><span>VCC</span><span></span></div><div class="pin-row battery-pin-row"><span>WIPER <small>ANALOG</small></span><button class="pin" data-pin="1" aria-label="Potentiometer wiper analog output"></button></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="2" aria-label="Potentiometer GND"></button><span>GND</span><span class="output-state">ADC ${Math.round(val * 1024)}</span></div>`;
  }
  if (n.type === 'buzzer') {
    return `<div class="node-body"><span class="buzzer-disc" aria-hidden="true"><i></i></span></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="0" aria-label="Buzzer signal input"></button><span>SIGNAL <small>+ PWM</small></span><span class="output-state">SILENT</span></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="1" aria-label="Buzzer ground"></button><span>GND <small>−</small></span><span></span></div>`;
  }
  if (n.type === 'resistor') {
    const ohms = n.ohms ?? 220;
    const label = ohms >= 1000 ? `${ohms / 1000} kΩ` : `${ohms} Ω`;
    return `<div class="node-body"><div class="resistor-art" aria-hidden="true"><span class="res-lead"></span><span class="res-body"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i></span><span class="res-lead"></span></div></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="0" aria-label="Resistor lead A"></button><span>LEAD A</span><span class="output-state">${esc(label)}</span></div><div class="pin-row battery-pin-row"><span>LEAD B</span><button class="pin" data-pin="1" aria-label="Resistor lead B"></button></div>`;
  }
  const indicator = n.type === 'led' ? '<span class="light"></span>' : n.type === 'motor' ? '<span class="rotor">✣</span>' : '<span class="arm"></span>';
  const body = photoUrl
    ? `<div class="node-body generic-art has-live-indicator">${componentArtHTML(definition, photoUrl, '')}<span class="live-indicator">${indicator}</span></div>`
    : `<div class="node-body">${indicator}</div>`;
  let rows = '';
  if (n.type === 'servo') rows = '<div class="pin-row servo-pin-row"><button class="pin input" data-pin="0" aria-label="Connect servo signal (orange)"></button><span>SIGNAL <small>ORANGE</small></span><span class="output-state">0°</span></div><div class="pin-row servo-pin-row"><button class="pin input" data-pin="1" aria-label="Connect servo power (red)"></button><span>V+ <small>RED</small></span><span></span></div><div class="pin-row servo-pin-row"><button class="pin input" data-pin="2" aria-label="Connect servo ground (brown or black)"></button><span>GND <small>BROWN / BLACK</small></span><span></span></div>';
  else if (n.type === 'led') rows = '<div class="pin-row component-pin-row"><button class="pin input" data-pin="0" aria-label="LED anode, positive"></button><span>ANODE <small>+</small></span><span class="output-state">OFF</span></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="1" aria-label="LED cathode, negative"></button><span>CATHODE <small>−</small></span><span></span></div>';
  else if (n.type === 'motor') rows = '<div class="pin-row component-pin-row"><button class="pin input" data-pin="0" aria-label="Motor terminal M plus"></button><span>M+ <small>MOTOR</small></span><span class="output-state">STOPPED</span></div><div class="pin-row component-pin-row"><button class="pin input" data-pin="1" aria-label="Motor terminal M minus"></button><span>M− <small>MOTOR</small></span><span></span></div>';
  else rows = '<div class="pin-row"><button class="pin input" data-pin="in" aria-label="Connect signal input"></button><span>SIGNAL IN</span><span class="output-state">—</span></div>';
  return `${body}${rows}`;
}

function espHTML(n) {
  const pins = RobotModel.pins(state, n);
  const side = name => pins.map((p, i) => ({ ...p, index: i })).filter(p => p.side === name).sort((a, b) => a.position - b.position);
  const silk = p => p.name.split(' / ')[0].replace(' · ADC', '');
  const pad = (p, sideName) => `<div class="esp-pad ${sideName}" title="${p.note ? esc(p.note) : esc(p.name + (p.gpio != null ? ' = GPIO' + p.gpio : ''))}">${sideName === 'left' ? `<span class="esp-label">${esc(silk(p))}</span>` : `<button class="pin esp-pin ${p.kind === 'input' ? 'input' : ''} ${p.kind === 'reserved' ? 'reserved' : ''} ${pending?.id === n.id && Number(pending.pin) === p.index ? 'pending' : ''}" data-pin="${p.index}" aria-label="${esc(p.name)}${p.gpio != null ? ' GPIO ' + p.gpio : ''} · ${esc(p.kind)}" ${p.kind === 'reserved' ? 'disabled aria-disabled="true"' : ''}></button>`}${sideName === 'left' ? `<button class="pin esp-pin ${p.kind === 'input' ? 'input' : ''} ${p.kind === 'reserved' ? 'reserved' : ''} ${pending?.id === n.id && Number(pending.pin) === p.index ? 'pending' : ''}" data-pin="${p.index}" aria-label="${esc(p.name)} · ${esc(p.kind)}" ${p.kind === 'reserved' ? 'disabled aria-disabled="true"' : ''}></button>` : `<span class="esp-label">${esc(silk(p))}</span>`}</div>`;
  return `<div class="node esp8266 ${n.id === selected ? 'selected' : ''}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px"><div class="node-header">NodeMCU DevKit v1.0<span class="node-label">ESP-12E</span></div><div class="esp-board"><span class="esp-hole hole-tl"></span><span class="esp-hole hole-tr"></span><span class="esp-hole hole-bl"></span><span class="esp-hole hole-br"></span><div class="esp-side left">${side('left').map(p => pad(p, 'left')).join('')}</div><div class="esp-core"><div class="esp-antenna" aria-hidden="true"></div><div class="esp-metal"><strong>WiFi</strong><small>ESP-12E · ESP8266</small></div><span class="esp-regulator">SPX3819</span><span class="esp-uart-chip">CP2102</span><span class="esp-led">●</span><span class="esp-control rst">RST</span><span class="esp-control flash">FLASH</span><span class="esp-usb" aria-label="Micro USB connector"></span></div><div class="esp-side right">${side('right').map(p => pad(p, 'right')).join('')}</div></div><div class="esp-caption">NodeMCU DevKit 1.0 · 30 header positions</div></div>`;
}

function view() {
  world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  viewport.style.backgroundSize = `${20 * zoom}px ${20 * zoom}px`;
  viewport.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
  $('#resetView').textContent = `${Math.round(zoom * 100)}%`;
}

function setRestoreControls() {
  for (const selector of ['#start', '#openDev', '#run', '#componentLibrary']) {
    const el = $(selector);
    if (el) el.inert = !!pendingRestore;
  }
}

function render() {
  setRestoreControls();
  window.Wiring?.cancel();
  $('#projectName').value = state.name;
  $('#empty').hidden = !!state.nodes.length;
  $('#nodes').innerHTML = state.nodes.map(n => n.type === 'esp8266'
    ? espHTML(n)
    : n.type === 'board'
      ? boardHTML(n)
      : `<div class="node ${esc(n.type)} ${n.id === selected ? 'selected' : ''}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px"><div class="node-header">${esc(componentLabel(n))}<span class="node-label">${state.nodes.filter(k => k.type === n.type).indexOf(n) + 1}</span></div>${n.type === 'mcu' ? `<div class="node-body">VIRTUAL CONTROLLER</div>${n.modes.map((m, p) => `<div class="pin-row"><span>D${p}</span><span class="pin-state" data-pin="${p}">LOW</span><button class="pin ${pending?.id === n.id && Number(pending.pin) === p ? 'pending' : ''}" data-pin="${p}" aria-label="Connect output D${p}"></button></div>`).join('')}` : peripheralHTML(n)}</div>`
  ).join('');
  const warnings = RobotModel.diagnostics(state).filter(item => item.severity === 'warning').length;
  $('#counts').textContent = `${state.nodes.length} components · ${state.wires.length} connections${warnings ? ` · ⚠ ${warnings}` : ''}`;
  view();
  drawWires();
  inspector();
  updateSignals();
  window.renderBoardLibrary?.();
  window.Firmware?.sync();
  save();
}

function pinElement(id, pin) {
  const n = state.nodes.find(n => n.id === id);
  if (!n) return null;
  return document.querySelector(`[data-id="${id}"] button[data-pin="${pin}"]`);
}

function wireCurve(a, b) {
  const bend = Math.max(35, Math.min(110, Math.abs(b.x - a.x) * 0.45));
  return `M${a.x} ${a.y} C${a.x + bend} ${a.y},${b.x - bend} ${b.y},${b.x} ${b.y}`;
}

function pinPoint(el) {
  const origin = world.getBoundingClientRect();
  const anchor = el.querySelector('.connection-dot') || el;
  const r = anchor.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - origin.left) / zoom, y: (r.top + r.height / 2 - origin.top) / zoom };
}

function drawWires() {
  const svg = $('#wires');
  svg.innerHTML = '';
  for (const w of state.wires) {
    const ap = pinElement(w.from, w.pin);
    const bp = pinElement(w.to, w.toPin ?? 0);
    if (!ap || !bp) continue;
    const target = RobotModel.attachmentKey(state, w);
    const role = RobotModel.wireRole(state, w);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', wireCurve(pinPoint(ap), pinPoint(bp)));
    path.setAttribute('class', `wire wire-${role} ${(selectedWire ? selectedWire === target : selected && (w.from === selected || w.to === selected)) ? 'selected' : ''}`);
    path.dataset.target = target;
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = 'Click to select this connection';
    path.append(title);
    path.addEventListener('click', e => {
      e.stopPropagation();
      selected = null;
      selectedWire = target;
      render();
      showConnectionDelete(e.clientX, e.clientY);
    });
    svg.append(path);
  }
}

function updateWirePaths(nodeId) {
  const byKey = new Map(state.wires.map(w => [RobotModel.attachmentKey(state, w), w]));
  document.querySelectorAll('#wires path.wire').forEach(path => {
    const w = byKey.get(path.dataset.target);
    if (!w || (w.from !== nodeId && w.to !== nodeId)) return;
    const ap = pinElement(w.from, w.pin);
    const bp = pinElement(w.to, w.toPin ?? 0);
    if (ap && bp) path.setAttribute('d', wireCurve(pinPoint(ap), pinPoint(bp)));
  });
}

// Web Audio API synthesizer for live piezo buzzer tones (silences automatically when paused or disconnected).
const BuzzerAudio = (() => {
  let ctx = null;
  const voices = new Map();
  function ensureCtx() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
    return ctx;
  }
  function set(id, active, freqHz) {
    if (!active || !running) {
      const v = voices.get(id);
      if (v) {
        try { v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01); v.osc.stop(ctx.currentTime + 0.04); } catch {}
        voices.delete(id);
      }
      return;
    }
    const audio = ensureCtx();
    if (!audio) return;
    const hz = Math.max(80, Math.min(8000, Number(freqHz) || 880));
    let v = voices.get(id);
    if (!v) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(hz, audio.currentTime);
      gain.gain.setValueAtTime(0.035, audio.currentTime);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      v = { osc, gain };
      voices.set(id, v);
    } else {
      try { v.osc.frequency.setTargetAtTime(hz, audio.currentTime, 0.015); } catch {}
    }
  }
  function prune(activeIds) {
    for (const id of [...voices.keys()]) {
      if (!activeIds.has(id)) set(id, false, 0);
    }
  }
  return { set, prune };
})();

function servoAngleFromMeta(meta) {
  if (!meta) return 0;
  if (meta.freq >= 30 && meta.freq <= 100 && meta.pulseUs >= 350 && meta.pulseUs <= 2700) {
    return Math.max(0, Math.min(180, Math.round(((meta.pulseUs - 500) / 2000) * 180)));
  }
  if (meta.freq > 0) {
    return Math.max(0, Math.min(180, Math.round(meta.duty * 180)));
  }
  return meta.high ? 180 : 0;
}

function updateSignals() {
  const driver = RobotModel.driverLookup(state);
  const out = (n, p) => RobotModel.output(state, n, p, started, elapsed, window.Firmware?.read, driver);
  const readIn = (n, p) => RobotModel.input(state, n, p, started, elapsed, window.Firmware?.read, driver);
  const metaIn = (n, p) => RobotModel.signalMeta(state, n, p, started, elapsed, window.Firmware?.read, window.Firmware?.pwm, driver);
  const buzzerIds = new Set();
  for (const n of state.nodes) {
    const el = document.querySelector(`[data-id="${n.id}"]`);
    if (!el) continue;
    if (isController(n)) {
      el.querySelectorAll('.pin-state').forEach(p => {
        p.textContent = (RobotModel.kind(state, n, p.dataset.pin) === 'input' ? readIn(n, +p.dataset.pin) : out(n, +p.dataset.pin)) ? 'HIGH' : 'LOW';
      });
      el.querySelectorAll('.pin').forEach(p => {
        const idx = +p.dataset.pin;
        const k = RobotModel.kind(state, n, idx);
        const pwm = k === 'output' && window.Firmware?.pwm ? window.Firmware.pwm(n, idx) : null;
        p.classList.toggle('high', k === 'input' ? readIn(n, idx) : (pwm && pwm.freq > 0 ? pwm.duty > 0.01 : out(n, idx)));
      });
    } else if (n.type === 'battery') {
      el.querySelectorAll('.pin').forEach(p => p.classList.toggle('high', out(n, +p.dataset.pin)));
    } else if (n.type === 'pushbutton') {
      const active = !!(n.pressed || n.latched);
      el.querySelector('.tactile-cap')?.classList.toggle('pressed', active);
      const capSpan = el.querySelector('.tactile-cap span');
      if (capSpan) capSpan.textContent = active ? 'HIGH' : 'PRESS';
      el.querySelector('.pin[data-pin="0"]')?.classList.toggle('high', started && active);
      el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', !!driver(n, 1));
      const st = el.querySelector('.output-state');
      if (st) st.textContent = active ? 'PRESSED' : 'OPEN';
    } else if (n.type === 'potentiometer') {
      const val = Math.max(0, Math.min(1, n.value ?? 0.5));
      el.querySelector('.pin[data-pin="0"]')?.classList.toggle('high', readIn(n, 0));
      el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', started && val > 0.05);
      el.querySelector('.pin[data-pin="2"]')?.classList.toggle('high', !!driver(n, 2));
      const st = el.querySelector('.output-state');
      if (st) st.textContent = `ADC ${Math.round(val * 1024)}`;
    } else if (n.type === 'resistor') {
      const active = readIn(n, 0) || readIn(n, 1);
      el.querySelectorAll('.pin').forEach(p => p.classList.toggle('high', active));
    } else if (n.type === 'buzzer') {
      buzzerIds.add(n.id);
      const hasGnd = !!driver(n, 1);
      const m = metaIn(n, 0);
      const active = started && hasGnd && (m.freq > 0 ? m.duty > 0.01 : m.high);
      const toneHz = m.freq > 0 ? m.freq : 880;
      el.querySelector('.pin[data-pin="0"]')?.classList.toggle('high', active);
      el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', hasGnd);
      el.querySelector('.buzzer-disc')?.classList.toggle('on', active);
      const st = el.querySelector('.output-state');
      if (st) st.textContent = active ? `${toneHz} Hz` : 'SILENT';
      BuzzerAudio.set(n.id, active && !n.muted, toneHz);
    } else if (ComponentRegistry.get(n.type)?.renderer === 'generic') {
      el.querySelectorAll('.pin').forEach(p => {
        const i = +p.dataset.pin;
        const kind = RobotModel.kind(state, n, i);
        p.classList.toggle('high', kind === 'output' ? out(n, i) : kind === 'power' ? true : readIn(n, i));
      });
    } else if (n.type === 'motorDriver' || n.type === 'ultrasonic') {
      el.querySelectorAll('.pin').forEach(p => {
        const i = +p.dataset.pin;
        const k = RobotModel.kind(state, n, i);
        p.classList.toggle('high', k === 'output' ? out(n, i) : k === 'ground-input' ? !!driver(n, i) : readIn(n, i));
      });
    } else {
      const hasPin = p => !!driver(n, p);
      let high = false;
      let label = '';
      let servoDeg = 0;
      let ledBrightness = 0;
      if (n.type === 'servo') {
        const m = metaIn(n, 0);
        servoDeg = servoAngleFromMeta(m);
        high = servoDeg > 0;
        label = `${servoDeg}°`;
      } else if (n.type === 'led') {
        const m = metaIn(n, 0);
        const grounded = hasPin(1);
        ledBrightness = grounded ? (m.freq > 0 ? m.duty : (m.high ? 1 : 0)) : 0;
        high = ledBrightness > 0.01;
        label = !high ? 'OFF' : (m.freq > 0 ? `${Math.round(ledBrightness * 100)}%` : 'ON');
        el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', grounded);
      } else if (n.type === 'motor') {
        const a = readIn(n, 0);
        const b = readIn(n, 1);
        high = hasPin(0) && hasPin(1) && a !== b;
        label = high ? (a ? 'FORWARD' : 'REVERSE') : 'STOPPED';
        el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', b);
      }
      el.querySelector('.pin[data-pin="0"],.pin[data-pin="in"]')?.classList.toggle('high', n.type === 'motor' ? readIn(n, 0) : high);
      el.querySelector('.output-state').textContent = label;
      const lightEl = el.querySelector('.light');
      if (lightEl) {
        lightEl.classList.toggle('on', high);
        lightEl.style.opacity = high ? String(0.35 + ledBrightness * 0.65) : '';
      }
      el.querySelector('.rotor')?.classList.toggle('on', high);
      if (n.type === 'motor') el.querySelector('.rotor').style.animationPlayState = running ? 'running' : 'paused';
      if (n.type === 'servo') el.querySelector('.arm').style.transform = `rotate(${servoDeg}deg)`;
    }
  }
  BuzzerAudio.prune(buzzerIds);
  document.querySelectorAll('.wire').forEach(p => {
    const w = state.wires.find(w => RobotModel.attachmentKey(state, w) === p.dataset.target);
    const fromNode = w && state.nodes.find(n => n.id === w.from);
    p.classList.toggle('high', !!fromNode && (out(fromNode, w.pin) || readIn(fromNode, w.pin)));
    p.style.animationPlayState = running ? 'running' : 'paused';
  });
  document.querySelectorAll('[data-board-reading]').forEach(el => {
    const n = state.nodes.find(n => n.id === selected);
    if (n) el.textContent = readIn(n, +el.dataset.boardReading) ? 'HIGH' : 'LOW';
  });
  const n = state.nodes.find(n => n.id === selected);
  if (n && !isController(n) && $('#reading')) {
    const pack = RobotModel.isCell(state, n) ? RobotModel.seriesInfo(state, n.id) : null;
    let reading = pack ? `Series pack: ${pack.count} cells${pack.totalVoltage ? ` · ~${pack.totalVoltage} V nominal` : ''} (cell ${pack.position} of ${pack.count})` : 'Power source';
    if (!started && !pack && !['pushbutton', 'potentiometer', 'resistor'].includes(n.type)) reading = 'Simulation stopped';
    else if (n.type === 'pushbutton') reading = (n.pressed || n.latched) ? 'Switch closed (OUT = HIGH)' : 'Switch open (OUT = LOW)';
    else if (n.type === 'potentiometer') {
      const val = Math.max(0, Math.min(1, n.value ?? 0.5));
      reading = `${Math.round(val * 100)}% · ${(val * 3.3).toFixed(2)} V · ADC ~${Math.round(val * 1024)} / 1024`;
    } else if (n.type === 'resistor') {
      const ohms = n.ohms ?? 220;
      reading = `Series resistance: ${ohms >= 1000 ? `${ohms / 1000} kΩ` : `${ohms} Ω`}`;
    } else if (n.type === 'buzzer') {
      const m = metaIn(n, 0);
      const active = started && !!driver(n, 1) && (m.freq > 0 ? m.duty > 0.01 : m.high);
      reading = !started ? 'Simulation stopped' : !driver(n, 1) ? 'Connect GND − to ground' : active ? `Playing ${m.freq > 0 ? m.freq : 880} Hz${n.muted ? ' (muted)' : ''}` : 'Silent (awaiting HIGH or PWM)';
    } else if (n.type === 'servo') {
      const m = metaIn(n, 0);
      const deg = servoAngleFromMeta(m);
      reading = !started ? 'Simulation stopped' : m.freq > 0 ? `Position: ${deg}° (PWM ${m.freq} Hz · ${m.pulseUs} µs)` : `Position: ${deg}°`;
    } else if (n.type === 'led') {
      const m = metaIn(n, 0);
      const grounded = !!driver(n, 1);
      reading = !started ? 'Simulation stopped' : (grounded && (m.freq > 0 ? m.duty > 0.01 : m.high)) ? (m.freq > 0 ? `LED dimmed ${Math.round(m.duty * 100)}% (PWM ${m.freq} Hz)` : 'LED on (signal high; cathode grounded)') : 'LED off (needs signal and ground)';
    } else if (n.type === 'motor') reading = !started ? 'Simulation stopped' : (!driver(n, 0) || !driver(n, 1)) ? 'Connect both motor terminals' : readIn(n, 0) === readIn(n, 1) ? 'Motor stopped (both terminals at same logic level)' : `Motor ${readIn(n, 0) ? 'forward' : 'reverse'} (logic model)`;
    else if (n.type === 'ultrasonic') {
      const dist = n.distanceCm ?? 40;
      const echoHigh = out(n, 2);
      reading = !started ? 'Simulation stopped' : !readIn(n, 0) || !driver(n, 3) ? 'Needs 5 V VCC and GND' : echoHigh ? `ECHO HIGH · ~${Math.round(dist * 58)} µs (${dist} cm)` : `Idle (${dist} cm) · pulse TRIG HIGH`;
    } else if (n.type === 'motorDriver') {
      const powered = readIn(n, 8) && readIn(n, 9) && (!!driver(n, 7) || !!driver(n, 10) || !!driver(n, 15));
      if (!started) reading = 'Simulation stopped';
      else if (!powered) reading = 'Needs VM, VCC, and GND';
      else if (!readIn(n, 3)) reading = 'Standby (set STBY HIGH to enable)';
      else {
        const ch = (ao1, ao2) => ao1 === ao2 ? 'STOP' : ao1 ? 'FWD' : 'REV';
        reading = `Ch A: ${ch(out(n, 11), out(n, 12))} · Ch B: ${ch(out(n, 14), out(n, 13))}`;
      }
    }
    $('#reading').textContent = reading;
  }
}

/* === src/app/inspector.js === */
// Component, board, and connection inspector panels.
function conductorDescription(def, id) {
  const group = def.conductors?.find(group => group.includes(id));
  if (!group) return '';
  return ' · connected to ' + group.filter(other => other !== id).map(other => def.pins.find(pin => pin.id === other)?.name || other).join(', ');
}

function genericInspector(n) {
  const def = ComponentRegistry.get(n.type);
  const sources = [
    ...(Array.isArray(def?.sources) ? def.sources : []),
    ...(def?.source ? [def.source] : []),
    ...(def?.visual?.imageSource ? [{ label: 'Component image source', url: def.visual.imageSource }] : [])
  ];
  const pins = RobotModel.pins(state, n);
  const rows = pins.map((pin, index) => {
    if (def.pins[index].kind === 'bidirectional') {
      return '<div class="bidirectional-pin"><span>' + esc(pin.name) + '</span><div class="pin-mode-controls">' +
        ['input', 'output'].map(direction => '<button type="button" data-pin-direction="' + index + '" data-direction="' + direction + '" aria-pressed="' + (pin.kind === direction) + '">' + (direction === 'input' ? 'Input' : 'Output') + '</button>').join('') +
        (pin.kind === 'output' ? ['low', 'high', 'blink'].map(mode => '<button type="button" class="pin-output-mode" data-pin-mode="' + index + '" data-mode="' + mode + '" aria-pressed="' + (n.modes[index] === mode) + '">' + (mode === 'blink' ? 'Pulse' : mode[0].toUpperCase() + mode.slice(1)) + '</button>').join('') : '') +
        '</div></div>';
    }
    return '<div>' + esc(pin.name) + ' <small>' + esc(pin.kind + conductorDescription(def, pin.id)) + '</small></div>';
  }).join('');
  const links = sources.filter(source => source && /^https:\/\//.test(source.url || '')).map(source => '<p class="inspect-help"><a href="' + esc(source.url) + '" target="_blank" rel="noopener">' + esc(source.label || source.title || 'Part reference') + '</a></p>').join('');
  const pack = RobotModel.isCell(state, n) ? RobotModel.seriesInfo(state, n.id) : null;
  const packBanner = pack ? `<div class="reading">Series pack: ${pack.count} cells${pack.totalVoltage ? ` · ~${pack.totalVoltage} V nominal` : ''} (cell ${pack.position} of ${pack.count})</div>` : '';
  const visualNotice = isVisualOnlyPart(def)
    ? '<div class="visual-only-notice" role="note">Visual &amp; pinout map only — internal IC or sensor behavior is not simulated.</div>'
    : '';
  $('#inspectorContent').innerHTML = '<h2 class="inspect-name">' + esc(def?.name || n.type) + '</h2><div class="inspect-type">' + esc(def?.category || 'Component') + '</div>' + visualNotice + packBanner + '<p class="inspect-help">' + esc(def?.help || 'Component pin map. Review the part documentation before wiring real hardware.') + '</p><div class="generic-inspector-pins"><strong>TERMINALS</strong>' + rows + '</div>' + links + (state.wires.some(wire => wire.to === n.id || wire.from === n.id) ? '<button class="remove-wire" id="disconnect">Disconnect all</button>' : '') + '<button class="remove-wire" id="removeSelected">Remove component</button>';
  document.querySelectorAll('[data-pin-mode]').forEach(button => button.onclick = () => {
    snapshot();
    n.modes[+button.dataset.pinMode] = button.dataset.mode;
    render();
  });
  document.querySelectorAll('[data-pin-direction]').forEach(button => button.onclick = () => {
    snapshot();
    n.pinDirections ??= def.pins.map(pin => pin.kind === 'bidirectional' ? 'input' : pin.kind);
    n.pinDirections[+button.dataset.pinDirection] = button.dataset.direction;
    state.wires = state.wires.filter(wire => RobotModel.wireValid(state, wire));
    render();
  });
  if ($('#disconnect')) $('#disconnect').onclick = () => { snapshot(); state.wires = state.wires.filter(wire => wire.to !== n.id && wire.from !== n.id); render(); };
  $('#removeSelected').onclick = removeSelected;
}

function connectionLabel(w) {
  const from = state.nodes.find(n => n.id === w.from);
  const to = state.nodes.find(n => n.id === w.to);
  return `${componentLabel(from || { type: 'Component' })} · ${pinName(from, w.pin)} ↔ ${componentLabel(to || { type: 'Component' })} · ${pinName(to, w.toPin ?? 0)}`;
}

function positionContextDelete(clientX, clientY) {
  let button = $('#wireContextDelete');
  if (!button) {
    button = document.createElement('button');
    button.id = 'wireContextDelete';
    button.className = 'wire-context-delete';
    button.type = 'button';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 10h13l1-10M9 7V4h6v3"/></svg>';
    button.onclick = e => {
      e.stopPropagation();
      if (contextDeleteMode === 'wire' && selectedWire) deleteWire(selectedWire);
      else if (contextDeleteMode === 'component' && contextComponentId) deleteComponentConnections(contextComponentId);
    };
    viewport.append(button);
  }
  const rect = viewport.getBoundingClientRect();
  button.style.left = `${Math.max(8, Math.min(clientX - rect.left + 12, rect.width - 44))}px`;
  button.style.top = `${Math.max(8, Math.min(clientY - rect.top + 12, rect.height - 44))}px`;
  button.hidden = false;
}

function showConnectionDelete(clientX, clientY) {
  contextDeleteMode = 'wire';
  contextComponentId = null;
  positionContextDelete(clientX, clientY);
  const button = $('#wireContextDelete');
  button.title = 'Delete selected connection';
  button.setAttribute('aria-label', 'Delete selected connection');
}

function showComponentDelete(el) {
  const id = el.dataset.id;
  if (!state.wires.some(w => w.from === id || w.to === id)) {
    hideConnectionDelete();
    return;
  }
  contextDeleteMode = 'component';
  contextComponentId = id;
  const rect = el.getBoundingClientRect();
  positionContextDelete(rect.right, rect.top + Math.min(rect.height / 2, 48));
  const button = $('#wireContextDelete');
  button.title = 'Delete all connections to this component';
  button.setAttribute('aria-label', 'Delete all connections to this component');
}

function hideConnectionDelete() {
  const button = $('#wireContextDelete');
  if (button) button.hidden = true;
  contextDeleteMode = null;
  contextComponentId = null;
}

function diagnosticsHTML(nodeId) {
  const issues = RobotModel.diagnostics(state).filter(item => item.nodeId === nodeId);
  if (!issues.length) return '';
  return `<div class="safety-warnings" role="note" aria-label="Hardware safety checks">${issues.map(item => {
    const sev = item.severity === 'warning' ? 'warning' : 'info';
    return `<div class="safety-item ${sev}"><strong>${sev === 'warning' ? '⚠' : 'ℹ'} ${esc(item.title)}</strong><p>${esc(item.detail)}</p></div>`;
  }).join('')}</div>`;
}

function connectionInspector(n) {
  const host = $('#inspectorContent');
  if (!n && selectedWire) {
    const w = state.wires.find(w => RobotModel.attachmentKey(state, w) === selectedWire);
    if (!w) return;
    host.innerHTML = `<h2 class="inspect-name">Connection</h2><div class="inspect-type">Selected wire</div><p class="inspect-help">${esc(connectionLabel(w))}</p><button class="remove-wire connection-delete" id="deleteConnection" aria-label="Delete connection">⌫ Delete connection</button>`;
    $('#deleteConnection').onclick = () => deleteWire(selectedWire);
    return;
  }
  if (!n) return;
  const diag = diagnosticsHTML(n.id);
  if (diag) host.insertAdjacentHTML('beforeend', diag);
  const wires = state.wires.filter(w => w.from === n.id || w.to === n.id);
  if (!wires.length) return;
  host.insertAdjacentHTML('beforeend', `<div class="connection-list"><div class="inspect-type">Connections · ${wires.length}</div>${wires.map(w => {
    const key = RobotModel.attachmentKey(state, w);
    return `<div class="connection-item"><button type="button" class="connection-select" data-wire-select="${esc(key)}">${esc(connectionLabel(w))}</button><button type="button" class="connection-delete-icon" data-wire-delete="${esc(key)}" aria-label="Delete ${esc(connectionLabel(w))}" title="Delete connection">⌫</button></div>`;
  }).join('')}</div>`);
  host.querySelectorAll('[data-wire-select]').forEach(b => b.onclick = () => {
    selectedWire = b.dataset.wireSelect;
    const rect = b.getBoundingClientRect();
    render();
    showConnectionDelete(rect.right, rect.top);
  });
  host.querySelectorAll('[data-wire-delete]').forEach(b => b.onclick = () => deleteWire(b.dataset.wireDelete));
}

function deleteWire(key) {
  const wire = state.wires.find(w => RobotModel.attachmentKey(state, w) === key);
  if (!wire) return;
  hideConnectionDelete();
  snapshot();
  state.wires = state.wires.filter(w => RobotModel.attachmentKey(state, w) !== key);
  selectedWire = null;
  render();
  toast('Connection removed. Undo to restore.');
}

function deleteComponentConnections(id) {
  if (!state.wires.some(w => w.from === id || w.to === id)) return;
  hideConnectionDelete();
  snapshot();
  state.wires = state.wires.filter(w => w.from !== id && w.to !== id);
  selectedWire = null;
  render();
  toast('Component connections removed. Undo to restore.');
}

function sourceLinksHTML(def, extraSource) {
  const all = [
    ...(Array.isArray(def?.sources) ? def.sources : []),
    ...(def?.source ? [def.source] : []),
    ...(extraSource ? [extraSource] : []),
    ...(def?.visual?.imageSource ? [{ label: 'Component image source', url: def.visual.imageSource }] : [])
  ];
  const seen = new Set();
  return all
    .filter(s => s && /^https:\/\//.test(s.url || '') && !seen.has(s.url) && (seen.add(s.url), true))
    .map(s => `<p class="inspect-help"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || s.title || 'Part reference')}</a></p>`)
    .join('');
}

function inspector() {
  const n = state.nodes.find(n => n.id === selected);
  if (n && RobotModel.firmwareTarget(state, n)) {
    firmwareInspector(n);
    connectionInspector(n);
    return;
  }
  if (n?.type === 'board') {
    boardInspector(n);
    connectionInspector(n);
    return;
  }
  const def = n ? ComponentRegistry.get(n.type) : null;
  if (n && def?.renderer === 'generic') {
    genericInspector(n);
    connectionInspector(n);
    return;
  }
  const sonarDist = n?.distanceCm ?? 40;
  const potPct = Math.round(Math.max(0, Math.min(1, n?.value ?? 0.5)) * 100);
  const resOhms = n?.ohms ?? 220;
  const pack = n?.type === 'battery' ? batteryInfo(n) : null;
  const helpText = pack
    ? `${pack.description || ''} Connect V+ and GND only to a load with a matching voltage rating. This canvas does not simulate voltage under load, charging, or current.`
    : (def?.help || 'Component loaded from catalog. Review manufacturer documentation before wiring real hardware.');
  const extraControls = n?.type === 'ultrasonic'
    ? `<label class="field-label" for="sonarDistance">Simulated target: <span id="sonarDistanceText">${sonarDist}</span> cm (~<span id="sonarPulseText">${Math.round(sonarDist * 58)}</span> µs)</label><input class="range" id="sonarDistance" type="range" min="2" max="400" step="1" value="${sonarDist}">`
    : n?.type === 'pushbutton'
      ? `<label class="signal-row"><span>Latch switch (stay HIGH)</span><input type="checkbox" id="buttonLatch" ${n.latched ? 'checked' : ''}></label>`
      : n?.type === 'potentiometer'
        ? `<label class="field-label" for="potInspectRange">Wiper position: <span id="potInspectText">${potPct}%</span></label><input class="range" id="potInspectRange" type="range" min="0" max="100" step="1" value="${potPct}">`
        : n?.type === 'buzzer'
          ? `<label class="signal-row"><span>Mute speaker audio</span><input type="checkbox" id="buzzerMute" ${n.muted ? 'checked' : ''}></label>`
          : n?.type === 'resistor'
            ? `<label class="signal-row"><span>Resistance</span><select id="resistorOhms">${[220, 330, 1000, 4700, 10000].map(v => `<option value="${v}" ${resOhms === v ? 'selected' : ''}>${v >= 1000 ? (v / 1000) + ' kΩ' : v + ' Ω'}</option>`).join('')}</select></label>`
            : '';
  $('#inspectorContent').innerHTML = n
    ? `<h2 class="inspect-name">${esc(componentLabel(n))}</h2><div class="inspect-type">${esc(def?.category || 'Component')}</div>${n.type === 'mcu' ? `<label class="field-label">OUTPUT BEHAVIOR</label>${n.modes.map((m, p) => `<label class="signal-row">D${p}<select data-mode="${p}" aria-label="D${p} behavior"><option value="low" ${m === 'low' ? 'selected' : ''}>Low</option><option value="high" ${m === 'high' ? 'selected' : ''}>High</option><option value="blink" ${m === 'blink' ? 'selected' : ''}>Pulse</option></select></label>`).join('')}<label class="field-label" for="period">Pulse cycle: <span id="periodText">${n.period.toFixed(1)}</span>s</label><input class="range" id="period" type="range" min="0.2" max="5" step="0.1" value="${n.period}"><p class="inspect-help">${esc(helpText)}</p>` : `<div class="reading" id="reading"></div>${extraControls}<p class="inspect-help">${esc(helpText)}</p>${sourceLinksHTML(def, pack?.source)}${state.wires.some(w => w.to === n.id || w.from === n.id) ? '<button class="remove-wire" id="disconnect">Disconnect all</button>' : ''}`}<button class="remove-wire" id="removeSelected">Remove component</button>`
    : '<div class="inspect-empty"><span class="inspect-icon">⌗</span><strong>Nothing selected</strong><p>Select a component on the canvas to see its properties.</p></div>';
  connectionInspector(n);
  if (!n) return;
  document.querySelectorAll('[data-mode]').forEach(s => s.onchange = () => { snapshot(); n.modes[+s.dataset.mode] = s.value; save(); updateSignals(); });
  if ($('#buttonLatch')) $('#buttonLatch').onchange = e => { snapshot(); n.latched = !!e.target.checked; save(); updateSignals(); window.Firmware?.sendInputs(); };
  if ($('#potInspectRange')) {
    $('#potInspectRange').onpointerdown = () => snapshot();
    $('#potInspectRange').oninput = e => {
      n.value = Number(e.target.value) / 100;
      $('#potInspectText').textContent = `${e.target.value}%`;
      const nodeEl = document.querySelector(`[data-id="${n.id}"]`);
      if (nodeEl) {
        const slider = nodeEl.querySelector('.pot-slider');
        if (slider) slider.value = e.target.value;
        const dial = nodeEl.querySelector('.pot-dial');
        if (dial) dial.style.setProperty('--dial-deg', `${Math.round(-135 + n.value * 270)}deg`);
        const readout = nodeEl.querySelector('.pot-readout');
        if (readout) readout.textContent = `${e.target.value}% · ${(n.value * 3.3).toFixed(2)}V`;
      }
      save();
      updateSignals();
      window.Firmware?.sendInputs();
    };
  }
  if ($('#buzzerMute')) $('#buzzerMute').onchange = e => { snapshot(); n.muted = !!e.target.checked; save(); updateSignals(); };
  if ($('#resistorOhms')) $('#resistorOhms').onchange = e => { snapshot(); n.ohms = Number(e.target.value); render(); };
  if ($('#period')) {
    $('#period').onpointerdown = () => snapshot();
    $('#period').onkeydown = e => { if (e.key.startsWith('Arrow')) snapshot(); };
    $('#period').oninput = e => { n.period = +e.target.value; $('#periodText').textContent = n.period.toFixed(1); save(); };
  }
  if ($('#sonarDistance')) {
    $('#sonarDistance').onpointerdown = () => snapshot();
    $('#sonarDistance').oninput = e => {
      n.distanceCm = +e.target.value;
      $('#sonarDistanceText').textContent = String(n.distanceCm);
      $('#sonarPulseText').textContent = String(Math.round(n.distanceCm * 58));
      save();
      updateSignals();
    };
  }
  if ($('#disconnect')) $('#disconnect').onclick = () => { snapshot(); state.wires = state.wires.filter(w => w.to !== n.id && w.from !== n.id); selectedWire = null; render(); };
  $('#removeSelected').onclick = removeSelected;
}

function boardInspector(n) {
  const b = boardFor(n);
  $('#inspectorContent').innerHTML = `<h2 class="inspect-name">${esc(b.name)}</h2><div class="inspect-type">Custom digital board · ${b.pins.length} pins</div>${b.pins.map((p, i) => `<div class="signal-row"><label for="customMode${i}">${esc(p.name)}<small class="pin-kind">${esc(p.kind)}</small></label>${p.kind === 'output' ? `<select id="customMode${i}" data-mode="${i}" aria-label="${esc(p.name)} behavior">${['low', 'high', 'blink'].map(m => `<option value="${m}" ${n.modes[i] === m ? 'selected' : ''}>${m === 'blink' ? 'Pulse' : m === 'high' ? 'High' : 'Low'}</option>`).join('')}</select>` : p.kind === 'input' ? `<span data-board-reading="${i}">LOW</span>` : `<span>${p.kind === 'power' ? 'HIGH' : 'LOW'}</span>`}</div>`).join('')}<label class="field-label" for="period">Pulse cycle: <span id="periodText">${n.period.toFixed(1)}</span>s</label><input class="range" id="period" type="range" min="0.2" max="5" step="0.1" value="${n.period}"><p class="inspect-help">Marked pins carry digital signals. Inputs show their received state; power and ground provide fixed High and Low. Firmware and electrical behavior are not emulated.</p><button class="remove-wire" id="editThisBoard">Edit board pins</button><button class="remove-wire" id="disconnectBoard">Disconnect all</button><button class="remove-wire" id="removeSelected">Remove component</button>`;
  document.querySelectorAll('[data-mode]').forEach(s => s.onchange = () => { snapshot(); n.modes[+s.dataset.mode] = s.value; save(); updateSignals(); });
  $('#period').onpointerdown = () => snapshot();
  $('#period').onkeydown = e => { if (e.key.startsWith('Arrow')) snapshot(); };
  $('#period').oninput = e => { n.period = +e.target.value; $('#periodText').textContent = n.period.toFixed(1); save(); };
  $('#editThisBoard').onclick = () => window.openBoardEditor(b.id);
  $('#disconnectBoard').onclick = () => { snapshot(); state.wires = state.wires.filter(w => w.from !== n.id && w.to !== n.id); render(); };
  $('#removeSelected').onclick = removeSelected;
}

/* === src/app/workspace.js === */
// Component library, canvas interaction, simulation loop, import/export, and saved projects.
function add(type, pack) {
  if (type === 'esp8266') return addEsp8266();
  const definition = ComponentRegistry.get(type);
  if (!definition) return toast('This component is not in the catalog yet.');
  if (state.nodes.length >= 150) return toast('This workspace supports up to 150 components.');
  snapshot();
  const rect = viewport.getBoundingClientRect();
  const offset = (state.nodes.length % 5) * 24;
  const n = {
    id: uid(),
    type,
    ...(definition.variants?.length ? { pack: pack || definition.variants[0].id } : {}),
    x: Math.round(((rect.width / 2 - 84 - pan.x) / zoom + offset) / 10) * 10,
    y: Math.round(((rect.height / 2 - 100 - pan.y) / zoom + offset) / 10) * 10,
    modes: definition.renderer === 'generic' ? definition.pins.map(() => 'low') : ['blink', 'low', 'low', 'low'],
    period: 1,
    ...(definition.pins.some(pin => pin.kind === 'bidirectional') ? { pinDirections: definition.pins.map(pin => pin.kind === 'bidirectional' ? 'input' : pin.kind) } : {})
  };
  state.nodes.push(n);
  selected = n.id;
  render();
  toast(`${catalogLabel(type)} added`);
}

const catalogIconClasses = new Set(['chip', 'battery', 'motor', 'sonar', 'led', 'servo']);
const catalogIconSymbols = {
  microchip: '▦', microcontroller: '▦', cpu: '▦', 'circuit-board': '▦', board: '▦',
  display: '▤', monitor: '▤', grid: '▦', keypad: '▦', wifi: '⌁', bluetooth: '⌁',
  audio: '♪', music: '♪', music_note: '♪', speaker: '♪', robot: '⚙', gamepad: '▦',
  eye: '◉', sensors: '◉', sensor: '◉', touch: '◉', 'sd-card': '▣', storage: '▣',
  power: 'ϟ', servo: '↗', motor: '⚙', can: '⇄', shield: '▧', component: '▦'
};

function catalogIcon(def) {
  const raw = String(def.icon || '').trim();
  const key = raw.toLowerCase().replace(/^fa[sr]?-/, '').replaceAll(' ', '-');
  const symbol = catalogIconSymbols[key] || (/^[^\p{L}\p{N}]{1,4}$/u.test(raw) ? raw : '▦');
  const style = String(def.iconClass || '').split(/\s+/).find(name => catalogIconClasses.has(name)) || 'chip';
  return { symbol, style };
}

function buildComponentLibrary() {
  const host = $('#componentLibrary');
  if (!host) return;
  const definitions = ComponentRegistry.catalog();
  const groups = new Map();
  for (const def of definitions) {
    if (!def.category || def.renderer === 'board') continue;
    if (!groups.has(def.category)) groups.set(def.category, []);
    const variants = def.variants?.length ? def.variants : [null];
    for (const variant of variants) groups.get(def.category).push({ def, variant });
  }
  host.innerHTML = [...groups].map(([category, items]) => `<details class="category-group" open><summary class="category">${esc(category)} <span>${items.length}</span></summary>${items.map(({ def, variant }) => {
    const icon = catalogIcon(def);
    return `<button class="part" data-type="${esc(def.id)}" ${variant ? `data-pack="${esc(variant.id)}"` : ''}><span class="part-art ${icon.style}" aria-hidden="true">${esc(icon.symbol)}</span><span><strong>${esc(variant?.name || def.name)}</strong><small>${esc(variant?.subtitle || def.subtitle || '')}</small></span><span class="add">+</span></button>`;
  }).join('')}</details>`).join('');
  $('#libraryCount').textContent = String([...groups.values()].reduce((sum, items) => sum + items.length, 0));
}

function initializeComponentLibrary() {
  document.querySelectorAll('.library > .category,.library > .part').forEach(el => el.remove());
  const host = document.createElement('div');
  host.id = 'componentLibrary';
  $('#noResults').before(host);
  buildComponentLibrary();
}

function removeSelected() {
  if (selectedWire) return deleteWire(selectedWire);
  if (!selected) return toast('Select a component or connection first.');
  snapshot();
  state.nodes = state.nodes.filter(n => n.id !== selected);
  state.wires = state.wires.filter(w => w.from !== selected && w.to !== selected);
  selected = null;
  selectedWire = null;
  pending = null;
  render();
}

function commitConnection(from, to) {
  const wire = RobotModel.connection(state, from, to);
  if (!wire) {
    toast('Choose compatible terminals on different components with at most one source per conductor.');
    return false;
  }
  const existing = state.wires.find(w => RobotModel.attachmentKey(state, w) === RobotModel.attachmentKey(state, wire));
  if (existing?.from === wire.from && existing.pin === wire.pin) {
    pending = null;
    render();
    return true;
  }
  if (!existing && state.wires.length >= 600) {
    toast('Maximum 600 connections per project.');
    return false;
  }
  snapshot();
  state.wires = state.wires.filter(w => RobotModel.attachmentKey(state, w) !== RobotModel.attachmentKey(state, wire));
  state.wires.push(wire);
  pending = null;
  render();
  toast(existing ? 'Input reconnected. Undo restores its previous connection.' : 'Pins connected');
  return true;
}

function connect(id, pin) {
  if (!pending) {
    pending = { id, pin };
    render();
    window.Wiring?.highlight(pending);
    toast('Drag to another pin, or click a compatible pin to connect.');
    return;
  }
  if (pending.id === id && String(pending.pin) === String(pin)) {
    pending = null;
    render();
    return;
  }
  commitConnection(pending, { id, pin });
}

let drag = null;
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button,input,select,.wire,#empty,.zoom,.floating-tools')) return;
  const el = e.target.closest('.node');
  if (el) {
    hideConnectionDelete();
    selected = el.dataset.id;
    selectedWire = null;
    document.querySelectorAll('.node').forEach(x => x.classList.toggle('selected', x === el));
    drawWires();
    inspector();
    updateSignals();
    showComponentDelete(el);
    const n = state.nodes.find(n => n.id === selected);
    drag = { kind: 'node', id: n.id, sx: e.clientX, sy: e.clientY, x: n.x, y: n.y, moved: false };
  } else {
    hideConnectionDelete();
    selected = null;
    selectedWire = null;
    pending = null;
    render();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, x: pan.x, y: pan.y };
  }
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (drag.kind === 'pan') {
    pan = { x: drag.x + dx, y: drag.y + dy };
    view();
  } else {
    if (!drag.moved && (Math.abs(dx) + Math.abs(dy) > 3)) {
      snapshot();
      drag.moved = true;
    }
    if (drag.moved) {
      const n = state.nodes.find(n => n.id === drag.id);
      n.x = Math.round((drag.x + dx / zoom) / 10) * 10;
      n.y = Math.round((drag.y + dy / zoom) / 10) * 10;
      const el = document.querySelector(`[data-id="${n.id}"]`);
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      updateWirePaths(n.id);
      if (contextDeleteMode === 'component') showComponentDelete(el);
    }
  }
});

for (const event of ['pointerup', 'pointercancel']) {
  viewport.addEventListener(event, () => {
    if (drag?.kind === 'node') save();
    drag = null;
  });
}

function setZoom(z, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
  const next = Math.max(0.3, Math.min(2, z));
  pan.x = cx - (cx - pan.x) * next / zoom;
  pan.y = cy - (cy - pan.y) * next / zoom;
  zoom = next;
  view();
}

viewport.addEventListener('wheel', e => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  setZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

$('#zoomIn').onclick = () => setZoom(zoom + 0.1);
$('#zoomOut').onclick = () => setZoom(zoom - 0.1);
$('#resetView').onclick = () => {
  zoom = 1;
  if (state.nodes.length) {
    const xs = state.nodes.map(n => n.x);
    const ys = state.nodes.map(n => n.y);
    pan = {
      x: viewport.clientWidth / 2 - (Math.min(...xs) + Math.max(...xs) + 168) / 2,
      y: viewport.clientHeight / 2 - (Math.min(...ys) + Math.max(...ys) + 200) / 2
    };
  } else {
    pan = { x: 0, y: 0 };
  }
  view();
};

initializeComponentLibrary();
$('#componentLibrary').onclick = e => {
  const b = e.target.closest('.part[data-type]');
  if (b) add(b.dataset.type, b.dataset.pack);
};
$('#start').onclick = () => add('esp8266');
$('#delete').onclick = removeSelected;

const componentHeading = document.querySelector('#controlsPanel > .section-title');
const closeComponents = document.createElement('button');
closeComponents.type = 'button';
closeComponents.className = 'dock-close';
closeComponents.id = 'closeComponents';
closeComponents.textContent = '×';
closeComponents.setAttribute('aria-label', 'Close component list');
componentHeading.append(closeComponents);

let activeLeftPanel = 'components';
function setLeftPanel(panel) {
  activeLeftPanel = panel;
  document.body.classList.toggle('components-open', panel === 'components');
  document.body.classList.toggle('templates-open', panel === 'templates');
  document.body.classList.toggle('components-closed', !panel);
  if ($('#controlsPanel')) $('#controlsPanel').hidden = panel !== 'components';
  if ($('#templatesPanel')) $('#templatesPanel').hidden = panel !== 'templates';
  $('#toggleComponents').setAttribute('aria-pressed', String(panel === 'components'));
  if ($('#toggleTemplates')) $('#toggleTemplates').setAttribute('aria-pressed', String(panel === 'templates'));
}
function setComponentsOpen(open) { setLeftPanel(open ? 'components' : null); }
closeComponents.onclick = () => setLeftPanel(null);
if ($('#closeTemplates')) $('#closeTemplates').onclick = () => setLeftPanel(null);
function setChatOpen(open) {
  document.body.classList.toggle('chat-closed', !open);
  document.body.classList.toggle('chat-open', open);
  $('#toggleChat').setAttribute('aria-pressed', String(open));
}
window.setChatOpen = setChatOpen;

const themeKey = 'microcontrollers-canvas-theme';
const themeMenu = $('#themeMenu');
const themeButton = $('#themeButton');
const themeColors = { blueprint: '#0b2545', light: '#f8faf9', dark: '#1e1e1e', 'high-contrast': '#000000' };
function setTheme(theme, persist = true) {
  if (!['blueprint', 'light', 'dark', 'high-contrast'].includes(theme)) theme = 'blueprint';
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeColors[theme]);
  themeMenu.querySelectorAll('[data-theme]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.theme === theme)));
  if (persist) try { localStorage.setItem(themeKey, theme); } catch {}
}
try { setTheme(localStorage.getItem(themeKey) || 'blueprint', false); } catch { setTheme('blueprint', false); }
themeButton.onclick = e => {
  e.stopPropagation();
  themeMenu.hidden = !themeMenu.hidden;
  themeButton.setAttribute('aria-expanded', String(!themeMenu.hidden));
};
themeMenu.onclick = e => {
  const button = e.target.closest('[data-theme]');
  if (!button) return;
  setTheme(button.dataset.theme);
  themeMenu.hidden = true;
  themeButton.setAttribute('aria-expanded', 'false');
};
document.addEventListener('click', e => {
  if (!e.target.closest('.theme-control')) {
    themeMenu.hidden = true;
    themeButton.setAttribute('aria-expanded', 'false');
  }
});

$('#toggleComponents').onclick = () => setLeftPanel(activeLeftPanel === 'components' ? null : 'components');
if ($('#toggleTemplates')) $('#toggleTemplates').onclick = () => setLeftPanel(activeLeftPanel === 'templates' ? null : 'templates');
$('#toggleChat').onclick = () => setChatOpen(document.body.classList.contains('chat-closed'));

function undo() {
  if (!history.length) return toast('Nothing to undo yet.');
  redoHistory.push(JSON.stringify(state));
  if (redoHistory.length > 40) redoHistory.shift();
  state = JSON.parse(history.pop());
  selected = null;
  selectedWire = null;
  pending = null;
  render();
  toast('Change undone');
}

function redo() {
  if (!redoHistory.length) return toast('Nothing to redo yet.');
  history.push(JSON.stringify(state));
  if (history.length > 40) history.shift();
  state = JSON.parse(redoHistory.pop());
  selected = null;
  selectedWire = null;
  pending = null;
  render();
  toast('Change redone');
}

$('#undo').onclick = undo;
if ($('#redo')) $('#redo').onclick = redo;
$('#selectTool').onclick = () => {
  pending = null;
  viewport.classList.remove('wiring');
  $('#selectTool').classList.add('active');
  $('#wireTool').classList.remove('active');
  render();
};
$('#wireTool').onclick = () => {
  viewport.classList.add('wiring');
  $('#wireTool').classList.add('active');
  $('#selectTool').classList.remove('active');
  toast('Drag from a pin to a highlighted compatible pin. You can also click two pins.');
};

function startLoop() { if (!rafId) rafId = requestAnimationFrame(tick); }
function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } last = 0; }

$('#run').onclick = () => {
  if (!state.nodes.some(n => isController(n) || RobotModel.pins(state, n).some(p => p.kind === 'output' || p.kind === 'power'))) {
    return toast('Add a microcontroller or power source to start simulating.');
  }
  running = !running;
  started = true;
  last = 0;
  window.Firmware?.sync();
  $('#run').innerHTML = running ? 'Ⅱ <span>Pause simulation</span>' : '▶ <span>Run simulation</span>';
  $('#simLabel').textContent = running ? 'Simulation running' : 'Simulation paused';
  $('#status').textContent = running ? 'Simulating digital signals' : 'Simulation paused';
  updateSignals();
  if (running) startLoop(); else stopLoop();
};

function tick(t) {
  rafId = 0;
  if (!running) return;
  if (last) elapsed += Math.min(t - last, 100);
  last = t;
  window.Firmware?.sendInputs();
  updateSignals();
  window.Firmware?.refreshPanel();
  rafId = requestAnimationFrame(tick);
}

$('#search').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  let count = 0;
  document.querySelectorAll('.part').forEach(b => {
    b.hidden = !!q && !b.textContent.toLowerCase().includes(q);
    if (!b.hidden) count++;
  });
  document.querySelectorAll('.category-group').forEach(group => {
    const visible = group.querySelectorAll('.part:not([hidden])').length;
    group.hidden = !visible;
    if (q && visible) group.open = true;
  });
  $('#noResults').hidden = !!count;
};

$('#projectName').onchange = e => {
  snapshot();
  state.name = e.target.value.trim() || 'Untitled project';
  if (pendingRestore) {
    pendingRestore.name = state.name;
    try {
      writeStoredProject(pendingRestore);
      $('#saved').textContent = 'Name saved · project needs unavailable parts';
    } catch {
      $('#saved').textContent = 'Not saved — export your project';
    }
  }
  render();
};

$('#clear').onclick = () => {
  if (!state.nodes.length) return toast('Your canvas is already blank.');
  snapshot();
  state.nodes = [];
  state.wires = [];
  selected = null;
  selectedWire = null;
  pending = null;
  running = false;
  started = false;
  elapsed = 0;
  stopLoop();
  $('#run').innerHTML = '▶ <span>Run simulation</span>';
  $('#simLabel').textContent = 'Simulation stopped';
  $('#status').textContent = 'Ready when you are';
  render();
  toast('Canvas cleared. Use Undo to restore.');
};

$('#exportBtn').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pendingRestore || state, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.name.replace(/[^a-z0-9_-]/gi, '-') || 'mcc-project') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Project exported');
};

$('#importBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (f.size > 8000000) throw Error('File is too large. Maximum: 8 MB.');
    const s = migrateProject(JSON.parse(await f.text()));
    if (!valid(s)) throw Error('Choose a valid MCC project JSON file.');
    snapshot();
    pendingRestore = null;
    currentProjectId = null;
    state = s;
    state.boards ??= [];
    selected = null;
    pending = null;
    render();
    $('#resetView').click();
    toast('Project imported. Undo restores your previous canvas.');
  } catch (err) {
    toast(err instanceof SyntaxError ? 'This file is not valid JSON.' : err.message);
  }
  e.target.value = '';
};

// Server-backed saved projects (local SQLite or authenticated cloud Supabase).
function projectsApiUrl() {
  return window.PROJECTS_ENDPOINT || (window.CANVAS_AI_ENDPOINT ? new URL(window.CANVAS_AI_ENDPOINT, location.href).origin + '/api/projects' : '/api/projects');
}
function projectAuthHeaders() {
  const token = window.MCC_AUTH_TOKEN || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function saveProjectToServer() {
  if (pendingRestore) return toast('Wait for the catalog to restore your saved project first.');
  try {
    const response = await fetch(projectsApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...projectAuthHeaders() },
      body: JSON.stringify({ id: currentProjectId || undefined, name: state.name, project: state })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Error(data?.error || `Save failed (${response.status}).`);
    currentProjectId = data.project?.id || currentProjectId;
    $('#saved').textContent = data.storage === 'cloud' ? 'Saved to cloud' : 'Saved to library';
    toast(`Saved "${state.name}"`);
  } catch (err) {
    toast(err.message || 'Could not save project to server.');
  }
}
async function openProjectsDialog() {
  const dialog = $('#projectsDialog');
  const list = $('#savedProjectsList');
  if (!dialog || !list) return;
  list.innerHTML = '<p class="subtle">Loading saved projects…</p>';
  dialog.showModal();
  try {
    const response = await fetch(projectsApiUrl(), { headers: { Accept: 'application/json', ...projectAuthHeaders() } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Error(data?.error || `Could not load projects (${response.status}).`);
    const items = Array.isArray(data.projects) ? data.projects : [];
    if (!items.length) {
      list.innerHTML = '<p class="subtle">No saved projects yet. Click Save to store your current circuit.</p>';
      return;
    }
    list.innerHTML = items.map((item, idx) => `<div class="saved-project-row"><button type="button" class="saved-project-open" data-open-project="${idx}"><strong>${esc(item.name)}</strong><small>${item.project?.nodes?.length || 0} parts · ${item.project?.wires?.length || 0} wires</small></button><button type="button" class="saved-project-del" data-del-project="${esc(item.id)}" aria-label="Delete ${esc(item.name)}">⌫</button></div>`).join('');
    list.querySelectorAll('[data-open-project]').forEach(btn => btn.onclick = () => {
      const item = items[+btn.dataset.openProject];
      const next = migrateProject(structuredClone(item.project));
      next.boards ??= [];
      if (!valid(next)) return toast('This saved project uses parts not currently in the catalog.');
      snapshot();
      pendingRestore = null;
      currentProjectId = item.id;
      state = next;
      selected = null;
      selectedWire = null;
      pending = null;
      running = false;
      started = false;
      elapsed = 0;
      stopLoop();
      $('#run').innerHTML = '▶ <span>Run simulation</span>';
      $('#simLabel').textContent = 'Simulation stopped';
      $('#status').textContent = 'Project loaded';
      dialog.close();
      render();
      $('#resetView').click();
      toast(`Opened "${item.name}"`);
    });
    list.querySelectorAll('[data-del-project]').forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.delProject;
      const res = await fetch(`${projectsApiUrl()}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...projectAuthHeaders() }
      });
      if (res.ok) {
        if (currentProjectId === id) currentProjectId = null;
        toast('Saved project deleted');
        openProjectsDialog();
      } else {
        toast('Could not delete project.');
      }
    });
  } catch (err) {
    list.innerHTML = `<p class="subtle">${esc(err.message || 'Saved projects are unavailable.')}</p>`;
  }
}
if ($('#saveProjectBtn')) $('#saveProjectBtn').onclick = saveProjectToServer;
if ($('#openProjectsBtn')) $('#openProjectsBtn').onclick = openProjectsDialog;
if ($('#closeProjectsDialog')) $('#closeProjectsDialog').onclick = () => $('#projectsDialog')?.close();
if ($('#projectsDialog')) $('#projectsDialog').addEventListener('click', e => { if (e.target === $('#projectsDialog')) $('#projectsDialog').close(); });

// Interactive canvas controls: tactile pushbutton press/hold and potentiometer knob/slider.
$('#nodes').addEventListener('pointerdown', e => {
  const cap = e.target.closest('.tactile-cap[data-pushbutton]');
  if (!cap) return;
  e.stopPropagation();
  const n = state.nodes.find(item => item.id === cap.dataset.pushbutton);
  if (!n) return;
  n.pressed = true;
  updateSignals();
  window.Firmware?.sendInputs();
});
for (const ev of ['pointerup', 'pointercancel']) {
  window.addEventListener(ev, () => {
    let changed = false;
    for (const n of state.nodes) {
      if (n.type === 'pushbutton' && n.pressed) { n.pressed = false; changed = true; }
    }
    if (changed) { updateSignals(); window.Firmware?.sendInputs(); }
  });
}
$('#nodes').addEventListener('input', e => {
  const slider = e.target.closest('.pot-slider[data-pot]');
  if (!slider) return;
  e.stopPropagation();
  const n = state.nodes.find(item => item.id === slider.dataset.pot);
  if (!n) return;
  n.value = Number(slider.value) / 100;
  const body = slider.closest('.pot-body');
  if (body) {
    body.querySelector('.pot-dial')?.style.setProperty('--dial-deg', `${Math.round(-135 + n.value * 270)}deg`);
    const readout = body.querySelector('.pot-readout');
    if (readout) readout.textContent = `${slider.value}% · ${(n.value * 3.3).toFixed(2)}V`;
  }
  if (selected === n.id && $('#potInspectRange')) {
    $('#potInspectRange').value = slider.value;
    $('#potInspectText').textContent = `${slider.value}%`;
  }
  save();
  updateSignals();
  window.Firmware?.sendInputs();
});

const photoDialog = $('#componentPhotoDialog');
$('#nodes').addEventListener('click', e => {
  const button = e.target.closest('.component-photo-open');
  if (!button || !photoDialog) return;
  const image = button.querySelector('img');
  $('#expandedComponentPhoto').src = image.src;
  $('#expandedComponentPhoto').alt = image.alt;
  $('#expandedComponentName').textContent = button.closest('.node')?.querySelector('.node-header')?.textContent.trim() || image.alt;
  const nodeEl = button.closest('.node');
  const node = state.nodes.find(item => item.id === nodeEl?.dataset.id);
  const component = ComponentRegistry.get(node?.type || nodeEl?.classList[1]);
  const details = component?.productDetails || {};
  const rows = [['Price', details.price ? '$' + details.price + ' USD' : ''], ['Availability', details.stock], ['Model', details.model], ['Part number', details.mpn], ['Manufacturer', details.manufacturer]].filter(([, value]) => value);
  $('#expandedComponentDetails').innerHTML = rows.map(([label, value]) => '<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('') + (details.url && /^https:\/\/(www\.)?adafruit\.com\//.test(details.url) ? '<a href="' + esc(details.url) + '" target="_blank" rel="noopener">View product details at Adafruit ↗</a>' : '');
  photoDialog.showModal();
});
$('#closeComponentPhoto').addEventListener('click', () => photoDialog.close());
photoDialog.addEventListener('click', e => { if (e.target === photoDialog) photoDialog.close(); });

document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,dialog')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
  if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  if (e.key === 'Escape') { window.Wiring?.cancel(); pending = null; selected = null; selectedWire = null; render(); }
});
render();
window.addEventListener('resize', drawWires);
document.fonts?.ready.then(drawWires);

/* === src/app/templates-ai.js === */
// Catalog refresh, templates panel, AI bridge, and board/ESP8266 helpers.
window.refreshComponentRegistry = definitions => {
  ComponentRegistry.replace(definitions);
  buildComponentLibrary();
  if (loadedTemplates.length) renderTemplates();
  $('#noResults').textContent = 'No components found.';
  $('#search').oninput({ target: $('#search') });
  if (pendingRestore) {
    if (!valid(migrateProject(pendingRestore))) {
      $('#saved').textContent = 'Saved project needs unavailable parts';
      return;
    }
    state = pendingRestore;
    state.boards ??= [];
    pendingRestore = null;
  }
  render();
};

let loadedTemplates = [];
function filterTemplates() {
  const q = ($('#templateSearch')?.value || '').trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('#templateList .template-item').forEach(btn => {
    btn.hidden = !!q && !btn.textContent.toLowerCase().includes(q);
    if (!btn.hidden) visible++;
  });
  document.querySelectorAll('#templateList .category-group').forEach(group => {
    const count = group.querySelectorAll('.template-item:not([hidden])').length;
    group.hidden = !count;
    if (q && count) group.open = true;
  });
  const empty = $('#noTemplates');
  if (empty) {
    empty.textContent = loadedTemplates.length ? 'No matching templates found.' : 'No templates available yet. Run the template worker to generate starter circuits.';
    empty.hidden = visible > 0;
  }
}
if ($('#templateSearch')) $('#templateSearch').oninput = filterTemplates;

function templateThumbsHTML(tpl) {
  const types = [...new Set((tpl.project?.nodes || []).map(n => n.type))];
  const thumbs = types.slice(0, 5).map(type => {
    const def = ComponentRegistry.get(type);
    if (def?.visual?.assetUrl) return `<img class="template-thumb-img" src="${esc(def.visual.assetUrl)}" alt="${esc(def.name || type)}" loading="lazy">`;
    const icon = catalogIcon(def || {});
    return `<span class="template-thumb-icon ${icon.style}" title="${esc(def?.name || type)}" aria-hidden="true">${esc(icon.symbol)}</span>`;
  }).join('');
  return thumbs ? `<div class="template-thumbs">${thumbs}</div>` : '';
}

function renderTemplates() {
  const list = $('#templateList');
  const count = $('#templateCount');
  if (!list || !count) return;
  count.textContent = String(loadedTemplates.length);
  const groups = new Map();
  loadedTemplates.forEach((tpl, idx) => {
    const cat = tpl.category || 'TEMPLATES';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ tpl, idx });
  });
  list.innerHTML = [...groups].map(([category, items]) => `<details class="category-group" open><summary class="category">${esc(category)} <span>${items.length}</span></summary>${items.map(({ tpl, idx }) => `<button type="button" class="template-item" data-template-idx="${idx}" title="${esc(tpl.realWorldNotes || tpl.description || tpl.name)}">${templateThumbsHTML(tpl)}<div class="template-head"><strong>${esc(tpl.name)}</strong>${tpl.difficulty ? `<span class="template-badge">${esc(tpl.difficulty)}</span>` : ''}</div>${tpl.description ? `<p class="template-desc">${esc(tpl.description)}</p>` : ''}<small>${tpl.project?.nodes?.length || 0} parts · ${tpl.project?.wires?.length || 0} wires</small></button>`).join('')}</details>`).join('');
  list.querySelectorAll('[data-template-idx]').forEach(button => button.onclick = () => {
    const tpl = loadedTemplates[+button.dataset.templateIdx];
    if (!tpl?.project) return;
    const next = migrateProject(structuredClone(tpl.project));
    next.boards ??= [];
    if (!valid(next)) return toast('This template requires components not yet loaded in the catalog.');
    snapshot();
    pendingRestore = null;
    currentProjectId = null;
    state = next;
    selected = null;
    selectedWire = null;
    pending = null;
    running = false;
    started = false;
    elapsed = 0;
    stopLoop();
    $('#run').innerHTML = '▶ <span>Run simulation</span>';
    $('#simLabel').textContent = 'Simulation stopped';
    $('#status').textContent = 'Template loaded';
    render();
    $('#resetView').click();
    toast(tpl.realWorldNotes ? `Loaded ${tpl.name}. ${tpl.realWorldNotes}` : `Loaded template: ${tpl.name}. Press Run simulation.`);
  });
  filterTemplates();
}

window.refreshTemplates = templates => {
  loadedTemplates = Array.isArray(templates) ? templates : [];
  renderTemplates();
};

window.applyExternalProject = (project, sourceLabel = 'AI agent (MCP)') => {
  if (!project || typeof project !== 'object') return false;
  const next = migrateProject(structuredClone(project));
  next.boards ??= [];
  if (!valid(next)) return false;
  snapshot();
  pendingRestore = null;
  currentProjectId = null;
  state = next;
  selected = next.nodes.at(-1)?.id || null;
  selectedWire = null;
  pending = null;
  running = false;
  started = false;
  elapsed = 0;
  stopLoop();
  $('#run').innerHTML = '▶ <span>Run simulation</span>';
  $('#simLabel').textContent = 'Simulation stopped';
  $('#status').textContent = `Loaded from ${sourceLabel}`;
  render();
  $('#resetView').click();
  toast(`Circuit pushed from ${sourceLabel}: ${next.name}`);
  return true;
};

window.CanvasAI = {
  current() {
    return state.nodes.map((n, index) => ({
      index,
      id: n.id,
      type: n.type,
      label: componentLabel(n),
      pins: RobotModel.pins(state, n).map((p, pin) => ({ pin, id: p.id, name: p.name, kind: p.kind })),
      conductors: ComponentRegistry.get(n.type)?.conductors
    }));
  },
  apply(plan) {
    if (pendingRestore) throw Error('Wait for the component catalog to restore your saved project.');
    if (!plan || !Array.isArray(plan.components) || !Array.isArray(plan.wires) || plan.components.length > 20 || plan.wires.length > 60) {
      throw Error('The proposed build is too large. Try a smaller idea.');
    }
    if (state.nodes.length + plan.components.length > 150) {
      throw Error('The canvas limit is 150 components. Remove a few parts first.');
    }
    if (plan.components.some(c => {
      const def = ComponentRegistry.get(c?.type);
      if (!def || (def.variants?.length && !def.variants.some(v => v.id === c.pack))) return true;
      const directions = c.pinDirections || [];
      return !Array.isArray(directions) || directions.some((entry, index) =>
        !entry || !Number.isInteger(entry.pin) || entry.pin < 0 || entry.pin >= def.pins.length ||
        def.pins[entry.pin].kind !== 'bidirectional' || !['input', 'output'].includes(entry.direction) ||
        directions.findIndex(other => other?.pin === entry.pin) !== index
      );
    })) throw Error('The plan included an unknown part or invalid GPIO direction.');
    if (plan.components.filter(c => c.type === 'esp8266').length + state.nodes.filter(n => RobotModel.firmwareTarget(state, n)).length > 4) {
      throw Error('This workspace supports up to four firmware boards per project.');
    }
    const rect = viewport.getBoundingClientRect();
    const existingRight = state.nodes.length ? Math.max(...state.nodes.map(n => n.x + (n.type === 'motorDriver' ? 270 : n.type === 'board' ? 300 : 190))) + 80 : null;
    const baseX = existingRight !== null ? existingRight : Math.round(((rect.width / 2 - pan.x) / zoom - 280) / 10) * 10;
    const baseY = state.nodes.length ? Math.round(Math.min(...state.nodes.map(n => n.y)) / 10) * 10 : Math.round(((rect.height / 2 - pan.y) / zoom - 140) / 10) * 10;
    const colY = [baseY, baseY, baseY];
    const colX = [baseX, baseX + 270, baseX + 560];
    const roleColumn = c => ['mcu', 'esp8266', 'battery'].includes(c.type) ? 0 : c.type === 'motorDriver' || ComponentRegistry.get(c.type)?.conductors?.length ? 1 : 2;
    const estHeight = c => {
      const def = ComponentRegistry.get(c.type);
      if (c.type === 'esp8266') return 360;
      if (c.type === 'motorDriver') return 460;
      return Math.max(190, 115 + (def?.pins?.length || 4) * 30);
    };
    const additions = plan.components.map(c => {
      const def = ComponentRegistry.get(c.type);
      const col = roleColumn(c);
      const x = Math.round(colX[col] / 10) * 10;
      const y = Math.round(colY[col] / 10) * 10;
      colY[col] += estHeight(c) + 40;
      return {
        id: uid(),
        type: c.type,
        ...(def.variants?.length ? { pack: c.pack } : {}),
        x,
        y,
        modes: c.type === 'esp8266' ? RobotModel.espPins.map(() => 'low') : def.renderer === 'generic' ? def.pins.map(() => 'low') : ['blink', 'low', 'low', 'low'],
        period: 1,
        ...(def.pins.some(pin => pin.kind === 'bidirectional') ? { pinDirections: def.pins.map((pin, index) => pin.kind === 'bidirectional' ? (c.pinDirections?.find(item => item.pin === index)?.direction || 'input') : pin.kind) } : {}),
        ...(c.type === 'esp8266' ? { firmware: { preset: 'blink' } } : {})
      };
    });
    const combined = [...state.nodes, ...additions];
    const newWires = [];
    for (const w of plan.wires) {
      if (!w || ![w.aComponent, w.aPin, w.bComponent, w.bPin].every(Number.isInteger) || w.aComponent < 0 || w.bComponent < 0 || w.aComponent >= combined.length || w.bComponent >= combined.length) {
        throw Error('The plan referred to a component or pin that does not exist.');
      }
      const wire = RobotModel.connection(
        { ...state, nodes: combined, wires: [...state.wires, ...newWires] },
        { id: combined[w.aComponent].id, pin: w.aPin },
        { id: combined[w.bComponent].id, pin: w.bPin }
      );
      if (!wire) {
        throw Error(`The suggested connection between ${componentLabel(combined[w.aComponent])} and ${componentLabel(combined[w.bComponent])} is not compatible with their pin types.`);
      }
      if (state.wires.some(existing => RobotModel.attachmentKey({ nodes: combined }, existing) === RobotModel.attachmentKey({ nodes: combined }, wire)) ||
          newWires.some(existing => RobotModel.attachmentKey({ nodes: combined }, existing) === RobotModel.attachmentKey({ nodes: combined }, wire))) continue;
      newWires.push(wire);
    }
    if (state.wires.length + newWires.length > 600) throw Error('The canvas limit is 600 connections per project.');
    const next = { ...state, nodes: combined, wires: [...state.wires, ...newWires] };
    if (!RobotModel.valid(next)) throw Error('The proposed build did not pass the canvas checks. Try describing a simpler circuit.');
    if (additions.length || newWires.length) {
      snapshot();
      state = next;
      selected = additions.at(-1)?.id || selected;
      pending = null;
      render();
    }
    return { added: additions.length, connected: newWires.length };
  }
};

function addBoard(id) {
  const b = state.boards.find(b => b.id === id);
  if (!b) return;
  if (b.runtime === 'esp8266' && state.nodes.filter(n => RobotModel.firmwareTarget(state, n)).length >= 4) {
    return toast('Up to four firmware boards can run per project.');
  }
  if (state.nodes.length >= 150) return toast('This workspace supports up to 150 components.');
  snapshot();
  const n = {
    id: uid(),
    type: 'board',
    boardId: id,
    x: (viewport.clientWidth / 2 - pan.x) / zoom - 140,
    y: (viewport.clientHeight / 2 - pan.y) / zoom - 100,
    modes: b.pins.map(() => 'low'),
    period: 1
  };
  if (b.runtime === 'esp8266') n.firmware = { preset: 'blink' };
  state.nodes.push(n);
  selected = n.id;
  render();
  toast('Board added. Connect a pin and set its output in the inspector.');
}

function addEsp8266() {
  if (state.nodes.length >= 150) return toast('Maximum 150 components.');
  if (state.nodes.filter(n => RobotModel.firmwareTarget(state, n)).length >= 4) {
    return toast('Up to four firmware boards can run per project.');
  }
  snapshot();
  const n = {
    id: uid(),
    type: 'esp8266',
    x: (viewport.clientWidth / 2 - pan.x) / zoom - 84,
    y: (viewport.clientHeight / 2 - pan.y) / zoom - 150,
    modes: RobotModel.espPins.map(() => 'low'),
    period: 1,
    firmware: { preset: 'blink' }
  };
  state.nodes.push(n);
  selected = n.id;
  render();
  toast('NodeMCU added. Run simulation to execute the Blink firmware on D4 / GPIO2.');
}
