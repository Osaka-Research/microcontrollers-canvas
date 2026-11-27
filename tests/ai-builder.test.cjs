const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('../.qa/node_modules/jsdom');

function boot(url = 'http://127.0.0.1:4173', fetchImpl) {
  const dom = new JSDOM(fs.readFileSync('dist/index.html', 'utf8'), { url, runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.Worker = class { postMessage() {} terminate() {} };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.fetch = fetchImpl || (async () => Response.json({ session: { sharing: false } }));
  const ctx = dom.getInternalVMContext();
  const run = code => vm.runInContext(code, ctx);
  for (const file of ['firmware-engine.js', 'component-registry.js', 'model.js', 'app.js', 'developer.js', 'firmware.js', 'wiring.js', 'ai-config.js', 'ai-builder.js']) {
    vm.runInContext(fs.readFileSync('dist/' + file, 'utf8'), ctx, { filename: file });
  }
  w.refreshComponentRegistry(require('../scripts/initial-component-catalog.cjs'));
  return { dom, w, run, $: s => w.document.querySelector(s) };
}

test('ai-builder initializes cleanly, switches providers, and preserves status after build', async () => {
  const requests = [];
  const fetchMock = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/chatgpt/session') {
      return Response.json({ session: { status: 'connected', sharing: true, profileLabel: 'dev@example.com' } });
    }
    if (url === '/api/chatgpt/models') {
      return Response.json({ models: [{ slug: 'gpt-6-luna' }] });
    }
    if (url === '/api/build') {
      const payload = JSON.parse(options.body);
      if (payload.action === 'check') return Response.json({ valid: true });
      return Response.json({
        plan: { summary: 'Added an LED.', components: [{ type: 'led', pack: '', pinDirections: [] }], wires: [] },
        definitions: [],
        sources: []
      });
    }
    return new Response(null, { status: 404 });
  };

  const b = boot('http://127.0.0.1:4173', fetchMock);
  try {
    const { $, w, run } = b;
    assert.ok($('#aiBuilder'));
    // Wait for async refreshChatGPT() on local 127.0.0.1
    await new Promise(r => setTimeout(r, 20));
    assert.match($('#aiState').textContent, /Using ChatGPT plan · dev@example\.com/);

    // Run a build under ChatGPT plan and verify status label is preserved
    $('#aiPrompt').value = 'Add an LED';
    $('#aiForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(run('state.nodes.length'), 1);
    assert.match($('#aiState').textContent, /Using ChatGPT plan · dev@example\.com/);

    // Switch to API key mode, connect a key, and build
    $('#apiKeyMode').click();
    assert.match($('#aiState').textContent, /OpenAI API key/);
    $('#aiPrompt').value = 'sk-test-valid-key-1234567890';
    $('#aiForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 20));
    assert.match($('#aiState').textContent, /API key connected · MCC AI ready/);

    $('#aiPrompt').value = 'Add another LED';
    $('#aiForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(run('state.nodes.length'), 2);
    assert.match($('#aiState').textContent, /API key connected · MCC AI ready/);
  } finally {
    b.dom.window.close();
  }
});
