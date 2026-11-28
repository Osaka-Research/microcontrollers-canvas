#!/usr/bin/env node
/**
 * Assemble modular frontend source files from src/app/ into dist/app.js.
 * Keeps browser runtime and VM-based test loading zero-dependency and consistent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = [
  'src/app/state.js',
  'src/app/render.js',
  'src/app/inspector.js',
  'src/app/workspace.js',
  'src/app/templates-ai.js'
];

const banner = `// Generated from src/app/*.js via "npm run build". Edit files in src/app/ instead.\n'use strict';\n`;
const body = modules.map(rel => {
  const src = readFileSync(path.join(root, rel), 'utf8').trim();
  return `\n/* === ${rel} === */\n${src}\n`;
}).join('');

writeFileSync(path.join(root, 'dist', 'app.js'), banner + body, 'utf8');
console.log(`Built dist/app.js from ${modules.length} source modules.`);
