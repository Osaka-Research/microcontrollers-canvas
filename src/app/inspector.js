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
