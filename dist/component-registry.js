'use strict';
(function(root) {
 const board = { id: 'board', name: 'Custom board', label: 'Custom board', pins: [], category: 'CUSTOM BOARDS', renderer: 'board' };
 let byId = new Map([[board.id, board]]);
 const clone = value => JSON.parse(JSON.stringify(value));

 function validConductors(entry) {
  const groups = entry.conductors ?? [];
  if (!Array.isArray(groups)) return false;
  const passive = new Map(entry.pins.filter(pin => ['passive-signal','passive-power','passive-ground'].includes(pin.kind))
   .map(pin => [pin.id, pin.kind]));
  if (passive.size && new Set(entry.pins.map(pin => pin.id)).size !== entry.pins.length) return false;
  const assigned = new Set();
  for (const group of groups) {
   if (!Array.isArray(group) || group.length < 2) return false;
   const kind = passive.get(group[0]);
   for (const id of group) {
    if (!kind || !id || assigned.has(id) || passive.get(id) !== kind) return false;
    assigned.add(id);
   }
  }
  return assigned.size === passive.size;
 }

 const registry = Object.freeze({
  validConductors,
  get entries() { return [...byId.values()]; },
  get(id) { return byId.get(id) || null; },
  types() { return [...byId.keys()]; },
  all() { return clone(this.entries.filter(entry => entry.id !== board.id)); },
  variants(id) { return clone(byId.get(id)?.variants || []); },
  pins(id) { return clone(byId.get(id)?.pins || []); },
  catalog() { return this.all().filter(entry => entry.enabled !== false); },
  replace(definitions) {
   if (!Array.isArray(definitions)) throw Error('Invalid component registry');
   const next = new Map();
   for (const entry of definitions) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(entry.id) ||
        entry.id === board.id || next.has(entry.id) || typeof entry.name !== 'string' ||
        !Array.isArray(entry.pins)) throw Error('Invalid component registry');
    if (!validConductors(entry)) throw Error('Invalid passive conductor mapping');
    next.set(entry.id, clone(entry));
   }
   next.set(board.id, board);
   byId = next;
  }
 });
 root.ComponentRegistry = registry;
 if (typeof module !== 'undefined' && module.exports) module.exports = registry;
})(globalThis);
