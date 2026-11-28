const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return require('../.qa/node_modules/jsdom'); } })();
const initialCatalog = require('../scripts/initial-component-catalog.cjs');

test('ESP8266 MicroPython supports real FRC1 hardware PWM duty/frequency and A0 ADC readings', () => {
  const ctx = vm.createContext({ console, Uint8Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, BigInt, Math, Number, String, Array, Object, Error, atob, btoa });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const f of ['vendor/esp8266/xtensa-esp8266.js', 'vendor/esp8266/rom-symbols.js', 'vendor/esp8266/rom8266.js', 'vendor/esp8266/firmware/micropython.js', 'firmware-engine.js']) {
    vm.runInContext(fs.readFileSync('dist/' + f, 'utf8'), ctx, { filename: f });
  }
  let out = '';
  const FirmwareEngine = vm.runInContext('FirmwareEngine', ctx);
  const m = FirmwareEngine.create({ preset: 'micropython' }, b => { out += String.fromCharCode(b); });
  for (let i = 0; i < 6000; i++) { m.step(1024); m.sys.addUs(200); if (out.includes('>>> ')) break; }
  assert.ok(out.includes('>>> '), 'MicroPython should boot to REPL');

  m.send('from machine import Pin, PWM, ADC\r');
  for (let i = 0; i < 300; i++) { m.step(1024); m.sys.addUs(100); }

  // Verify A0 ADC tracks 0.0 -> 0.5 -> 1.0
  m.adc(0.0); out = '';
  m.send('print("A0", ADC(0).read())\r');
  for (let i = 0; i < 300; i++) { m.step(1024); m.sys.addUs(100); }
  assert.equal(Number(out.match(/A0 (\d+)/)?.[1]), 0);

  m.adc(0.5); out = '';
  m.send('print("A5", ADC(0).read())\r');
  for (let i = 0; i < 300; i++) { m.step(1024); m.sys.addUs(100); }
  const mid = Number(out.match(/A5 (\d+)/)?.[1]);
  assert.ok(mid >= 480 && mid <= 540, `Expected mid ADC ~512, got ${mid}`);

  m.adc(1.0); out = '';
  m.send('print("A1", ADC(0).read())\r');
  for (let i = 0; i < 300; i++) { m.step(1024); m.sys.addUs(100); }
  const full = Number(out.match(/A1 (\d+)/)?.[1]);
  assert.ok(full >= 990 && full <= 1024, `Expected full ADC ~1024, got ${full}`);

  // Verify FRC1 hardware PWM toggles GPIO2 at ~200 Hz, 25% and 75% duty
  m.send('p = PWM(Pin(2), freq=200, duty=256)\r');
  for (let i = 0; i < 1500; i++) { m.step(512); m.sys.addUs(40); }
  const lowDuty = m.outputs();
  assert.ok(lowDuty.freq[2] >= 180 && lowDuty.freq[2] <= 220, `Expected ~200 Hz, got ${lowDuty.freq[2]}`);
  assert.ok(lowDuty.duty[2] >= 0.20 && lowDuty.duty[2] <= 0.30, `Expected ~0.25 duty, got ${lowDuty.duty[2]}`);

  m.send('p.duty(768)\r');
  for (let i = 0; i < 1500; i++) { m.step(512); m.sys.addUs(40); }
  const highDuty = m.outputs();
  assert.ok(highDuty.duty[2] >= 0.68 && highDuty.duty[2] <= 0.80, `Expected ~0.75 duty, got ${highDuty.duty[2]}`);
});

test('interactive pushbutton, potentiometer, piezo buzzer, and series resistor work in canvas', () => {
  const dom = new JSDOM(fs.readFileSync('dist/index.html', 'utf8'), { url: 'http://127.0.0.1:4173', runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.Worker = class { postMessage() {} terminate() {} };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const ctx = dom.getInternalVMContext();
  for (const file of ['firmware-engine.js', 'component-registry.js', 'model.js', 'app.js', 'developer.js', 'firmware.js', 'wiring.js']) {
    vm.runInContext(fs.readFileSync('dist/' + file, 'utf8'), ctx, { filename: file });
  }
  try {
    w.refreshComponentRegistry(initialCatalog);

    // Pushbutton -> LED (through series Resistor) + Battery GND
    vm.runInContext("add('pushbutton'); add('resistor'); add('led'); add('battery');", ctx);
    vm.runInContext("commitConnection({id:state.nodes[0].id,pin:0},{id:state.nodes[1].id,pin:0});", ctx);
    vm.runInContext("commitConnection({id:state.nodes[1].id,pin:1},{id:state.nodes[2].id,pin:0});", ctx);
    vm.runInContext("commitConnection({id:state.nodes[3].id,pin:1},{id:state.nodes[2].id,pin:1});", ctx);
    // Series resistor suppresses missing-resistor LED warning/info
    assert.equal(vm.runInContext("RobotModel.diagnostics(state).filter(d => d.nodeId === state.nodes[2].id).length", ctx), 0);

    // Run simulation and press pushbutton -> LED lights up
    w.document.querySelector('#run').click();
    assert.equal(w.document.querySelector('.node.led .light').classList.contains('on'), false);
    const cap = w.document.querySelector('.tactile-cap');
    cap.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    assert.equal(w.document.querySelector('.node.led .light').classList.contains('on'), true);
    w.dispatchEvent(new w.Event('pointerup'));
    assert.equal(w.document.querySelector('.node.led .light').classList.contains('on'), false);

    // Potentiometer wired to NodeMCU A0 feeds continuous analog 0..1 into RobotModel.analogInput
    vm.runInContext("add('esp8266'); add('potentiometer');", ctx);
    vm.runInContext("commitConnection({id:state.nodes[5].id,pin:1},{id:state.nodes[4].id,pin:13});", ctx);
    const slider = w.document.querySelector('.pot-slider');
    slider.value = '75';
    slider.dispatchEvent(new w.Event('input', { bubbles: true }));
    const a0 = vm.runInContext("RobotModel.analogInput(state, state.nodes[4], 13, true, 0)", ctx);
    assert.equal(a0, 0.75);

    // Piezo Buzzer wired to Pushbutton (latched) + Battery GND activates visual disc & 880 Hz readout
    vm.runInContext("add('buzzer'); state.nodes[0].latched = true;", ctx);
    vm.runInContext("commitConnection({id:state.nodes[0].id,pin:0},{id:state.nodes[6].id,pin:0});", ctx);
    vm.runInContext("commitConnection({id:state.nodes[3].id,pin:1},{id:state.nodes[6].id,pin:1});", ctx);
    assert.equal(w.document.querySelector('.buzzer-disc').classList.contains('on'), true);
    assert.equal(w.document.querySelector('.node.buzzer .output-state').textContent, '880 Hz');
  } finally {
    dom.window.close();
  }
});
