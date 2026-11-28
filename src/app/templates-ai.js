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
