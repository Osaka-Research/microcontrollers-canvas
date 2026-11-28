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

function updateSignals() {
  const driver = RobotModel.driverLookup(state);
  const out = (n, p) => RobotModel.output(state, n, p, started, elapsed, window.Firmware?.read, driver);
  const readIn = (n, p) => RobotModel.input(state, n, p, started, elapsed, window.Firmware?.read, driver);
  for (const n of state.nodes) {
    const el = document.querySelector(`[data-id="${n.id}"]`);
    if (!el) continue;
    if (isController(n)) {
      el.querySelectorAll('.pin-state').forEach(p => {
        p.textContent = (RobotModel.kind(state, n, p.dataset.pin) === 'input' ? readIn(n, +p.dataset.pin) : out(n, +p.dataset.pin)) ? 'HIGH' : 'LOW';
      });
      el.querySelectorAll('.pin').forEach(p => {
        p.classList.toggle('high', RobotModel.kind(state, n, p.dataset.pin) === 'input' ? readIn(n, +p.dataset.pin) : out(n, +p.dataset.pin));
      });
    } else if (n.type === 'battery') {
      el.querySelectorAll('.pin').forEach(p => p.classList.toggle('high', out(n, +p.dataset.pin)));
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
      if (n.type === 'servo') {
        high = readIn(n, 0);
        label = high ? '180°' : '0°';
      } else if (n.type === 'led') {
        high = readIn(n, 0) && hasPin(1);
        label = high ? 'ON' : 'OFF';
        el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', hasPin(1));
      } else if (n.type === 'motor') {
        const a = readIn(n, 0);
        const b = readIn(n, 1);
        high = hasPin(0) && hasPin(1) && a !== b;
        label = high ? (a ? 'FORWARD' : 'REVERSE') : 'STOPPED';
        el.querySelector('.pin[data-pin="1"]')?.classList.toggle('high', b);
      }
      el.querySelector('.pin[data-pin="0"],.pin[data-pin="in"]')?.classList.toggle('high', n.type === 'motor' ? readIn(n, 0) : high);
      el.querySelector('.output-state').textContent = label;
      el.querySelector('.light,.rotor')?.classList.toggle('on', high);
      if (n.type === 'motor') el.querySelector('.rotor').style.animationPlayState = running ? 'running' : 'paused';
      if (n.type === 'servo') el.querySelector('.arm').style.transform = `rotate(${high ? 180 : 0}deg)`;
    }
  }
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
    if (!started && !pack) reading = 'Simulation stopped';
    else if (n.type === 'servo') reading = !started ? 'Simulation stopped' : `Position: ${readIn(n, 0) ? 180 : 0}°`;
    else if (n.type === 'led') reading = !started ? 'Simulation stopped' : (readIn(n, 0) && !!driver(n, 1)) ? 'LED on (signal high; cathode grounded)' : 'LED off (needs signal and ground)';
    else if (n.type === 'motor') reading = !started ? 'Simulation stopped' : (!driver(n, 0) || !driver(n, 1)) ? 'Connect both motor terminals' : readIn(n, 0) === readIn(n, 1) ? 'Motor stopped (both terminals at same logic level)' : `Motor ${readIn(n, 0) ? 'forward' : 'reverse'} (logic model)`;
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
