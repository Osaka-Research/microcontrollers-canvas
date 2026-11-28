// @ts-check
'use strict';

const ComponentRegistry = require('../../dist/component-registry');
const RobotModel = require('../../dist/model');

/**
 * Validate an AI-generated build plan on the server using the same
 * ComponentRegistry and RobotModel rules enforced by the browser canvas.
 *
 * @param {any} plan
 * @param {any[]} existingComponents
 * @param {any[]} catalog
 * @returns {{ ok: boolean, plan?: any, error?: string }}
 */
function validateBuildPlan(plan, existingComponents, catalog) {
  if (!plan || typeof plan !== 'object' || typeof plan.summary !== 'string' ||
      !Array.isArray(plan.components) || !Array.isArray(plan.wires)) {
    return { ok: false, error: 'The AI build plan did not match the expected format.' };
  }
  if (plan.components.length > 20 || plan.wires.length > 60) {
    return { ok: false, error: 'The AI build plan exceeded component or wire limits.' };
  }

  const existing = Array.isArray(existingComponents) ? existingComponents.slice(0, 150) : [];
  if (existing.length + plan.components.length > 150) {
    return { ok: false, error: 'The AI build plan exceeds the 150-component workspace limit.' };
  }

  const previousDefs = ComponentRegistry.all();
  const validCatalog = catalog.filter(def => def && typeof def.id === 'string' && def.id !== 'board' && Array.isArray(def.pins));
  try {
    ComponentRegistry.replace(validCatalog);
    const byId = new Map(validCatalog.map(def => [def.id, def]));

    // Validate requested new components & their pinDirections
    const normalizedComponents = [];
    for (const part of plan.components) {
      if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
        return { ok: false, error: 'The AI build plan referenced an invalid component.' };
      }
      const def = byId.get(part.type);
      if (!def || def.enabled === false) {
        return { ok: false, error: `The AI build plan used an unavailable component: ${part.type}.` };
      }
      const pack = typeof part.pack === 'string' ? part.pack : '';
      if (Array.isArray(def.variants) && def.variants.length) {
        if (!def.variants.some(v => v.id === pack)) {
          return { ok: false, error: `Invalid variant "${pack}" for component ${part.type}.` };
        }
      }
      const directions = Array.isArray(part.pinDirections) ? part.pinDirections : [];
      const seenPins = new Set();
      for (const entry of directions) {
        if (!entry || !Number.isInteger(entry.pin) || entry.pin < 0 || entry.pin >= def.pins.length ||
            def.pins[entry.pin].kind !== 'bidirectional' || !['input', 'output'].includes(entry.direction) ||
            seenPins.has(entry.pin)) {
          return { ok: false, error: `Invalid pin direction in AI plan for ${part.type}.` };
        }
        seenPins.add(entry.pin);
      }
      normalizedComponents.push({ type: part.type, pack, pinDirections: directions });
    }

    // Build synthetic canvas state combining existing context components + newly planned parts
    const boards = [];
    const nodes = [];
    for (let i = 0; i < existing.length; i++) {
      const item = existing[i];
      if (!item || typeof item !== 'object') continue;
      const nodeId = typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) ? item.id : `existing_${i}`;
      if (item.type === 'board' || !byId.has(item.type)) {
        // Synthesize a custom board definition from the context pins so existing custom boards validate cleanly.
        const boardId = `ctx_board_${i}`;
        const rawPins = Array.isArray(item.pins) && item.pins.length ? item.pins : [{ id: 'p0', name: 'P0', kind: 'input' }];
        const validKinds = new Set(['output', 'input', 'drive-input', 'power', 'ground', 'power-input', 'ground-input', 'reserved', 'bidirectional']);
        const boardPins = rawPins.slice(0, 64).map((p, idx) => ({
          id: typeof p?.id === 'string' && /^[\w-]{1,80}$/.test(p.id) ? p.id : `p${idx}`,
          name: (typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : `P${idx}`).slice(0, 32),
          kind: validKinds.has(p?.kind) ? p.kind : 'reserved',
          x: 0.5,
          y: 0.5
        }));
        boards.push({
          id: boardId,
          name: `Board ${i}`,
          image: 'data:image/png;base64,AA==',
          width: 100,
          height: 100,
          pins: boardPins
        });
        nodes.push({
          id: nodeId,
          type: 'board',
          boardId,
          x: i * 100,
          y: 0,
          modes: boardPins.map(() => 'low'),
          period: 1
        });
        continue;
      }
      const def = byId.get(item.type);
      const pinDirections = item.type === 'esp8266'
        ? def.pins.map((p, idx) => (p.gpio != null && ['input', 'output'].includes(item.pins?.[idx]?.kind) ? item.pins[idx].kind : p.kind))
        : def.pins.some(p => p.kind === 'bidirectional')
          ? def.pins.map((p, idx) => (p.kind === 'bidirectional' ? (['input', 'output'].includes(item.pins?.[idx]?.kind) ? item.pins[idx].kind : 'input') : p.kind))
          : undefined;
      nodes.push({
        id: nodeId,
        type: item.type,
        x: i * 100,
        y: 0,
        modes: item.type === 'esp8266' ? def.pins.map(() => 'low') : def.renderer === 'generic' ? def.pins.map(() => 'low') : ['low', 'low', 'low', 'low'],
        period: 1,
        ...(pinDirections ? { pinDirections } : {})
      });
    }

    for (let i = 0; i < normalizedComponents.length; i++) {
      const part = normalizedComponents[i];
      const def = byId.get(part.type);
      const pinDirections = def.pins.some(p => p.kind === 'bidirectional')
        ? def.pins.map((p, idx) => p.kind === 'bidirectional'
          ? (part.pinDirections.find(d => d.pin === idx)?.direction || 'input')
          : p.kind)
        : undefined;
      nodes.push({
        id: `added_${i}`,
        type: part.type,
        ...(def.variants?.length ? { pack: part.pack } : {}),
        x: (existing.length + i) * 100,
        y: 200,
        modes: part.type === 'esp8266' ? def.pins.map(() => 'low') : def.renderer === 'generic' ? def.pins.map(() => 'low') : ['low', 'low', 'low', 'low'],
        period: 1,
        ...(pinDirections ? { pinDirections } : {}),
        ...(part.type === 'esp8266' ? { firmware: { preset: 'blink' } } : {})
      });
    }

    const firmwareCount = nodes.filter(n => RobotModel.firmwareTarget({ boards, nodes }, n)).length;
    if (firmwareCount > 4) {
      return { ok: false, error: 'The AI build plan exceeds the limit of four firmware boards.' };
    }

    const state = { name: 'Plan check', boards, nodes, wires: [] };
    const validatedWires = [];
    const seenKeys = new Set();

    for (const w of plan.wires) {
      if (!w || ![w.aComponent, w.aPin, w.bComponent, w.bPin].every(Number.isInteger) ||
          w.aComponent < 0 || w.bComponent < 0 || w.aComponent >= nodes.length || w.bComponent >= nodes.length) {
        return { ok: false, error: 'The AI build plan referenced an out-of-range component or pin.' };
      }
      const wire = RobotModel.connection(
        state,
        { id: nodes[w.aComponent].id, pin: w.aPin },
        { id: nodes[w.bComponent].id, pin: w.bPin }
      );
      if (!wire) {
        return { ok: false, error: 'The AI build plan included an incompatible pin connection or conflicting conductor driver.' };
      }
      const key = RobotModel.attachmentKey(state, wire);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      state.wires.push(wire);
      validatedWires.push({ aComponent: w.aComponent, aPin: w.aPin, bComponent: w.bComponent, bPin: w.bPin });
    }

    if (!RobotModel.valid(state)) {
      return { ok: false, error: 'The AI build plan failed circuit model validation.' };
    }

    return {
      ok: true,
      plan: {
        summary: plan.summary,
        components: normalizedComponents,
        wires: validatedWires
      }
    };
  } finally {
    try { ComponentRegistry.replace(previousDefs); } catch {}
  }
}

module.exports = { validateBuildPlan };
