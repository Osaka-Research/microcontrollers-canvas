'use strict';
(function(root) {
 const board = { id: 'board', name: 'Custom board', label: 'Custom board', pins: [], category: 'CUSTOM BOARDS', renderer: 'board' };
 let byId = new Map([[board.id, board]]);
 const clone = value => JSON.parse(JSON.stringify(value));

 const registry = Object.freeze({
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
    next.set(entry.id, clone(entry));
   }
   next.set(board.id, board);
   byId = next;
  }
 });
 root.ComponentRegistry = registry;
 if (typeof module !== 'undefined' && module.exports) module.exports = registry;
})(globalThis);
