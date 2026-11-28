const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return require('../.qa/node_modules/jsdom'); } })();
const initialCatalog = require('../scripts/initial-component-catalog.cjs');

function makeMockSerialPort(onHostWrite) {
  const rxQueue = [];
  let rxResolve = null;
  let closed = false;
  const signals = [];

  function pushFromDevice(bytes) {
    const arr = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new TextEncoder().encode(String(bytes));
    if (rxResolve) {
      const resolve = rxResolve;
      rxResolve = null;
      resolve({ value: arr, done: false });
    } else {
      rxQueue.push(arr);
    }
  }

  const port = {
    signals,
    pushFromDevice,
    getInfo() { return { usbVendorId: 0x10C4, usbProductId: 0xEA60 }; },
    async open() { closed = false; },
    async close() {
      closed = true;
      if (rxResolve) { const r = rxResolve; rxResolve = null; r({ value: undefined, done: true }); }
    },
    async setSignals(sig) { signals.push(sig); },
    readable: {
      getReader() {
        return {
          async read() {
            if (rxQueue.length) return { value: rxQueue.shift(), done: false };
            if (closed) return { value: undefined, done: true };
            return new Promise(resolve => { rxResolve = resolve; });
          },
          async cancel() {
            closed = true;
            if (rxResolve) { const r = rxResolve; rxResolve = null; r({ value: undefined, done: true }); }
          },
          releaseLock() {}
        };
      }
    },
    writable: {
      getWriter() {
        return {
          async write(bytes) { onHostWrite(bytes, pushFromDevice); },
          releaseLock() {}
        };
      }
    }
  };
  return port;
}

test('WebSerialFlasher SLIP framing, ESP8266 ROM bootloader flash, and MicroPython main.py deploy', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:4173', runScripts: 'outside-only' });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  ctx.TextEncoder = TextEncoder;
  ctx.TextDecoder = TextDecoder;
  ctx.btoa = btoa;
  ctx.atob = atob;

  const receivedFrames = [];
  const flashedBlocks = [];
  let replRx = '';

  const port = makeMockSerialPort((bytes, reply) => {
    // Check if SLIP frame (starts with 0xC0)
    if (bytes[0] === 0xC0 && bytes[bytes.length - 1] === 0xC0) {
      const flasher = w.WebSerialFlasher;
      const decoded = flasher._internals.slipDecode(bytes);
      const op = decoded[1];
      const len = decoded[2] | (decoded[3] << 8);
      const chk = decoded[4];
      const payload = decoded.subarray(8, 8 + len);
      receivedFrames.push({ op, len, chk });

      if (op === flasher._internals.OP_FLASH_DATA) {
        const seq = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24);
        const block = payload.subarray(16);
        assert.equal(flasher._internals.espChecksum(block), chk, 'Block XOR checksum must match');
        flashedBlocks.push({ seq, size: block.length });
      }
      // Build ESP8266 ROM bootloader OK response [dir=0x01, op, size=2,0, val=0,0,0,0, status=0, err=0]
      const resp = new Uint8Array([0x01, op, 2, 0, 0, 0, 0, 0, 0, 0]);
      reply(flasher._internals.slipEncode(resp));
      return;
    }
    // Otherwise MicroPython REPL serial text
    replRx += new TextDecoder().decode(bytes);
    if (replRx.includes('MCC_MAIN_PY_SAVED')) {
      reply('MCC_MAIN_PY_SAVED\r\n>>> ');
    }
  });

  w.navigator.serial = { async requestPort() { return port; } };
  vm.runInContext(fs.readFileSync('dist/web-serial.js', 'utf8'), ctx, { filename: 'web-serial.js' });

  try {
    const flasher = w.WebSerialFlasher;
    assert.equal(flasher.isSupported(), true);

    // SLIP roundtrip with special bytes 0xC0 and 0xDB
    const special = new Uint8Array([0x01, 0xC0, 0xDB, 0xDC, 0xDD, 0x42]);
    assert.deepEqual(Array.from(flasher._internals.slipDecode(flasher._internals.slipEncode(special))), Array.from(special));

    await flasher.connect({ baudRate: 115200 });
    assert.equal(flasher.isConnected(), true);

    // Flash 2500-byte test firmware -> 3 x 1024-byte blocks
    const bin = new Uint8Array(2500);
    bin[0] = 0xE9;
    for (let i = 1; i < bin.length; i++) bin[i] = (i * 37) & 0xFF;

    const progress = [];
    const result = await flasher.flashBinary(bin, { address: 0, reboot: true, onProgress: p => progress.push(p) });
    assert.equal(result.blocks, 3);
    assert.equal(flashedBlocks.length, 3);
    assert.deepEqual(flashedBlocks.map(b => b.seq), [0, 1, 2]);
    assert.equal(progress.at(-1), 100);
    assert.ok(port.signals.length >= 3, 'Should toggle DTR/RTS to enter bootloader and reboot');

    // Deploy MicroPython script to main.py
    const dep = await flasher.deployMicroPython('print("hello from mcc")', { saveAsMain: true });
    assert.equal(dep.mode, 'main.py');
    assert.match(replRx, /open\('main\.py', 'wb'\)/);
    assert.match(replRx, /ubinascii\.a2b_base64/);

    await flasher.disconnect();
    assert.equal(flasher.isConnected(), false);
  } finally {
    dom.window.close();
  }
});

test('NodeMCU inspector renders Web Serial USB controls and connects cleanly', async () => {
  const dom = new JSDOM(fs.readFileSync('dist/index.html', 'utf8'), { url: 'http://127.0.0.1:4173', runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.Worker = class { postMessage() {} terminate() {} };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const port = makeMockSerialPort(() => {});
  w.navigator.serial = { async requestPort() { return port; } };

  const ctx = dom.getInternalVMContext();
  ctx.TextEncoder = TextEncoder;
  ctx.TextDecoder = TextDecoder;
  for (const file of ['firmware-engine.js', 'component-registry.js', 'model.js', 'app.js', 'developer.js', 'web-serial.js', 'firmware.js', 'wiring.js']) {
    vm.runInContext(fs.readFileSync('dist/' + file, 'utf8'), ctx, { filename: file });
  }
  try {
    w.refreshComponentRegistry(initialCatalog);
    vm.runInContext("addEsp8266(); state.nodes[0].firmware={preset:'micropython'}; render();", ctx);
    assert.ok(w.document.querySelector('.usb-flash-panel'));
    assert.equal(w.document.querySelector('#usbConnectBtn').disabled, false);
    w.document.querySelector('#usbConnectBtn').click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.WebSerialFlasher.isConnected(), true);
    assert.ok(w.document.querySelector('#usbSaveMainBtn'));
    assert.ok(w.document.querySelector('#usbFlashMpBtn'));
    assert.ok(w.document.querySelector('#usbBinFile'));
    w.document.querySelector('#usbConnectBtn').click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.WebSerialFlasher.isConnected(), false);
  } finally {
    dom.window.close();
  }
});
