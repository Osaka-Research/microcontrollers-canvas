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
