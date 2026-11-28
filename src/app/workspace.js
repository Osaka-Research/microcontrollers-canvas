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
  if (e.button !== 0 || e.target.closest('button,.wire,#empty,.zoom,.floating-tools')) return;
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
