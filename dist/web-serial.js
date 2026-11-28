'use strict';
/**
 * Web Serial API driver for flashing ESP8266 firmware (.bin via ROM SLIP bootloader)
 * and deploying MicroPython scripts (live run or persistent main.py) to physical boards.
 */
window.WebSerialFlasher = (() => {
  const SLIP_END = 0xC0;
  const SLIP_ESC = 0xDB;
  const SLIP_ESC_END = 0xDC;
  const SLIP_ESC_ESC = 0xDD;

  const OP_FLASH_BEGIN = 0x02;
  const OP_FLASH_DATA = 0x03;
  const OP_FLASH_END = 0x04;
  const OP_SYNC = 0x08;
  const FLASH_BLOCK_SIZE = 1024;
  const FLASH_SECTOR_SIZE = 4096;

  let activePort = null;
  let activeReader = null;
  let activeWriter = null;
  let readLoopPromise = null;
  let rxListeners = new Set();
  let rxTextHandler = null;
  let busy = false;

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial && typeof navigator.serial.requestPort === 'function';
  }

  function espChecksum(bytes) {
    let chk = 0xEF;
    for (let i = 0; i < bytes.length; i++) chk ^= bytes[i];
    return chk & 0xFF;
  }

  function slipEncode(payload) {
    const out = [SLIP_END];
    for (let i = 0; i < payload.length; i++) {
      const b = payload[i];
      if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
      else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
      else out.push(b);
    }
    out.push(SLIP_END);
    return new Uint8Array(out);
  }

  function slipDecode(frame) {
    const out = [];
    let esc = false;
    for (let i = 0; i < frame.length; i++) {
      const b = frame[i];
      if (b === SLIP_END) continue;
      if (esc) {
        if (b === SLIP_ESC_END) out.push(SLIP_END);
        else if (b === SLIP_ESC_ESC) out.push(SLIP_ESC);
        else out.push(b);
        esc = false;
      } else if (b === SLIP_ESC) {
        esc = true;
      } else {
        out.push(b);
      }
    }
    return new Uint8Array(out);
  }

  function packLE32(value) {
    return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
  }

  function buildCommand(op, payload, checksum = 0) {
    const len = payload.length;
    const pkt = new Uint8Array(8 + len);
    pkt[0] = 0x00; // request direction
    pkt[1] = op & 0xFF;
    pkt[2] = len & 0xFF;
    pkt[3] = (len >>> 8) & 0xFF;
    pkt[4] = checksum & 0xFF;
    pkt[5] = (checksum >>> 8) & 0xFF;
    pkt[6] = (checksum >>> 16) & 0xFF;
    pkt[7] = (checksum >>> 24) & 0xFF;
    pkt.set(payload, 8);
    return slipEncode(pkt);
  }

  function parseResponse(rawBytes) {
    if (!rawBytes || rawBytes.length < 10) return null;
    if (rawBytes[0] !== 0x01) return null; // response direction
    const op = rawBytes[1];
    const size = rawBytes[2] | (rawBytes[3] << 8);
    const val = (rawBytes[4] | (rawBytes[5] << 8) | (rawBytes[6] << 16) | (rawBytes[7] << 24)) >>> 0;
    const data = rawBytes.subarray(8, 8 + size);
    // ESP8266 ROM bootloader appends 2 status bytes [status, error] at end of data
    const status = data.length >= 2 ? data[data.length - 2] : 1;
    const error = data.length >= 2 ? data[data.length - 1] : 0;
    return { op, size, val, data, ok: status === 0, status, error };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function startReadLoop() {
    if (!activePort?.readable) return;
    const decoder = new TextDecoder();
    activeReader = activePort.readable.getReader();
    readLoopPromise = (async () => {
      try {
        while (activeReader) {
          const { value, done } = await activeReader.read();
          if (done) break;
          if (value && value.length) {
            for (const fn of rxListeners) fn(value);
            if (!busy && rxTextHandler) {
              rxTextHandler(decoder.decode(value, { stream: true }));
            }
          }
        }
      } catch {
        // Port closed or unplugged
      }
    })();
  }

  async function writeBytes(bytes) {
    if (!activeWriter) throw Error('Connect a USB board first.');
    await activeWriter.write(bytes);
  }

  async function connect({ baudRate = 115200, onText } = {}) {
    if (!isSupported()) {
      throw Error('Web Serial API is not supported in this browser. Use Chrome, Edge, or Opera on desktop over HTTPS or localhost.');
    }
    if (activePort) await disconnect();
    rxTextHandler = onText || null;
    const port = await navigator.serial.requestPort({
      filters: [
        { usbVendorId: 0x10C4 }, // Silicon Labs CP210x (NodeMCU v1.0)
        { usbVendorId: 0x1A86 }, // WCH CH340/CH341 (NodeMCU clones)
        { usbVendorId: 0x0403 }, // FTDI FT232
        { usbVendorId: 0x303A }, // Espressif native USB
        { usbVendorId: 0x2E8A }  // Raspberry Pi Pico
      ]
    }).catch(async err => {
      // If user wants an unfiltered port or browser rejects filters, rethrow cancel directly.
      if (err?.name === 'NotFoundError' || err?.name === 'AbortError') throw err;
      return navigator.serial.requestPort();
    });
    await port.open({ baudRate });
    activePort = port;
    activeWriter = port.writable.getWriter();
    startReadLoop();
    return port.getInfo?.() || {};
  }

  async function disconnect() {
    busy = false;
    rxListeners.clear();
    try { await activeReader?.cancel(); } catch {}
    try { activeReader?.releaseLock?.(); } catch {}
    activeReader = null;
    try { await readLoopPromise; } catch {}
    readLoopPromise = null;
    try { activeWriter?.releaseLock?.(); } catch {}
    activeWriter = null;
    try { await activePort?.close(); } catch {}
    activePort = null;
  }

  function isConnected() {
    return !!activePort;
  }

  function setTextHandler(fn) {
    rxTextHandler = fn || null;
  }

  async function sendSerialText(text) {
    const encoder = new TextEncoder();
    await writeBytes(encoder.encode(String(text)));
  }

  /**
   * Pulse DTR/RTS lines using the NodeMCU auto-reset circuit to enter the ESP8266 ROM bootloader.
   */
  async function enterBootloader() {
    if (!activePort?.setSignals) return;
    // NodeMCU transistor auto-program circuit: DTR=IO0, RTS=RST (active low inverted)
    await activePort.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await activePort.setSignals({ dataTerminalReady: true, requestToSend: false });
    await sleep(50);
    await activePort.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  async function hardReset() {
    if (!activePort?.setSignals) return;
    await activePort.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await activePort.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  /**
   * Send a SLIP-framed bootloader command and wait for the matching response packet.
   */
  async function sendCommand(op, payload, { checksum = 0, timeoutMs = 3000 } = {}) {
    const frameBytes = buildCommand(op, payload, checksum);
    return new Promise((resolve, reject) => {
      let inFrame = false;
      let buf = [];
      const timer = setTimeout(() => {
        rxListeners.delete(onChunk);
        reject(Error(`Bootloader timed out waiting for opcode 0x${op.toString(16)}.`));
      }, timeoutMs);

      function onChunk(chunk) {
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          if (b === SLIP_END) {
            if (inFrame && buf.length > 0) {
              const decoded = slipDecode(new Uint8Array(buf));
              const resp = parseResponse(decoded);
              buf = [];
              if (resp && resp.op === op) {
                clearTimeout(timer);
                rxListeners.delete(onChunk);
                resolve(resp);
                return;
              }
            }
            inFrame = true;
            buf = [];
          } else if (inFrame) {
            buf.push(b);
          }
        }
      }

      rxListeners.add(onChunk);
      writeBytes(frameBytes).catch(err => {
        clearTimeout(timer);
        rxListeners.delete(onChunk);
        reject(err);
      });
    });
  }

  async function syncBootloader({ attempts = 8, onStatus } = {}) {
    const syncPayload = new Uint8Array(36);
    syncPayload[0] = 0x07;
    syncPayload[1] = 0x07;
    syncPayload[2] = 0x12;
    syncPayload[3] = 0x20;
    syncPayload.fill(0x55, 4);

    for (let i = 0; i < attempts; i++) {
      onStatus?.(`Syncing with ESP8266 bootloader (${i + 1}/${attempts})…`);
      if (i % 2 === 0) await enterBootloader();
      try {
        const resp = await sendCommand(OP_SYNC, syncPayload, { timeoutMs: 450 });
        if (resp.ok) return true;
      } catch {
        // Retry sync pulse
      }
    }
    throw Error('Could not sync with ESP8266 bootloader. Hold the FLASH button on the board, tap RST, and retry.');
  }

  /**
   * Flash a raw ESP8266 .bin firmware image over Web Serial using the ROM SLIP bootloader.
   */
  async function flashBinary(rawBytes, { address = 0, reboot = true, onProgress, onStatus } = {}) {
    if (!activePort) throw Error('Connect a USB board first.');
    if (!ArrayBuffer.isView(rawBytes) || rawBytes.byteLength < 16) {
      throw Error('Invalid firmware binary.');
    }
    const imageBytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    if (busy) throw Error('A USB operation is already in progress.');
    busy = true;
    try {
      await syncBootloader({ onStatus });

      const numBlocks = Math.ceil(imageBytes.length / FLASH_BLOCK_SIZE);
      const eraseSize = Math.ceil(imageBytes.length / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
      onStatus?.(`Erasing ${Math.round(eraseSize / 1024)} KB at 0x${address.toString(16)}…`);

      const beginPayload = new Uint8Array([
        ...packLE32(eraseSize),
        ...packLE32(numBlocks),
        ...packLE32(FLASH_BLOCK_SIZE),
        ...packLE32(address >>> 0)
      ]);
      const beginResp = await sendCommand(OP_FLASH_BEGIN, beginPayload, { timeoutMs: 12000 });
      if (!beginResp.ok) throw Error(`Flash begin failed (status 0x${beginResp.status.toString(16)}).`);

      for (let seq = 0; seq < numBlocks; seq++) {
        const block = new Uint8Array(FLASH_BLOCK_SIZE);
        block.fill(0xFF);
        const start = seq * FLASH_BLOCK_SIZE;
        block.set(imageBytes.subarray(start, Math.min(start + FLASH_BLOCK_SIZE, imageBytes.length)), 0);

        const dataPayload = new Uint8Array(16 + FLASH_BLOCK_SIZE);
        dataPayload.set([...packLE32(FLASH_BLOCK_SIZE), ...packLE32(seq), 0, 0, 0, 0, 0, 0, 0, 0], 0);
        dataPayload.set(block, 16);

        const resp = await sendCommand(OP_FLASH_DATA, dataPayload, {
          checksum: espChecksum(block),
          timeoutMs: 5000
        });
        if (!resp.ok) throw Error(`Flash write failed at block ${seq}/${numBlocks} (err 0x${resp.error.toString(16)}).`);
        const pct = Math.round(((seq + 1) / numBlocks) * 100);
        onProgress?.(pct, seq + 1, numBlocks);
        onStatus?.(`Flashing ${pct}% (${seq + 1}/${numBlocks} KB)…`);
      }

      const endPayload = new Uint8Array(packLE32(reboot ? 0 : 1));
      await sendCommand(OP_FLASH_END, endPayload, { timeoutMs: 3000 }).catch(() => {});
      if (reboot) await hardReset();
      onProgress?.(100, numBlocks, numBlocks);
      onStatus?.(reboot ? 'Firmware flashed and board rebooted.' : 'Firmware flashed.');
      return { bytes: rawBytes.length, blocks: numBlocks, address };
    } finally {
      busy = false;
    }
  }

  /**
   * Deploy a MicroPython script over Web Serial REPL (either run immediately in RAM
   * or write persistently to main.py and soft-reboot).
   */
  async function deployMicroPython(script, { saveAsMain = false, onStatus } = {}) {
    if (!activePort) throw Error('Connect a USB board first.');
    if (busy) throw Error('A USB operation is already in progress.');
    const code = String(script || '').replace(/\r\n/g, '\n').trim();
    if (!code) throw Error('Write a MicroPython script first.');
    busy = true;
    try {
      onStatus?.(saveAsMain ? 'Writing main.py to USB board…' : 'Sending script to USB board…');
      // Interrupt any running program to reach REPL
      await sendSerialText('\x03\x03');
      await sleep(120);

      if (!saveAsMain) {
        await sendSerialText('\x05' + code.replace(/\n/g, '\r') + '\r\x04');
        onStatus?.('Script sent to USB board.');
        return { mode: 'ram', bytes: code.length };
      }

      // Base64-encode UTF-8 bytes so indentation/quotes/newlines write losslessly into main.py
      const utf8 = new TextEncoder().encode(code + '\n');
      let bin = '';
      for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
      const b64 = btoa(bin);
      const chunks = [];
      for (let i = 0; i < b64.length; i += 120) chunks.push(b64.slice(i, i + 120));

      const loader = [
        'import ubinascii',
        "f = open('main.py', 'wb')",
        ...chunks.map(c => `f.write(ubinascii.a2b_base64('${c}'))`),
        'f.close()',
        "print('MCC_MAIN_PY_SAVED')"
      ].join('\r');

      const decoder = new TextDecoder();
      let seen = '';
      const ackPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rxListeners.delete(onChunk);
          reject(Error('Board did not confirm saving main.py. Ensure MicroPython is flashed on the board.'));
        }, 4000);
        function onChunk(chunk) {
          seen += decoder.decode(chunk, { stream: true });
          if (seen.includes('MCC_MAIN_PY_SAVED')) {
            clearTimeout(timer);
            rxListeners.delete(onChunk);
            resolve();
          }
        }
        rxListeners.add(onChunk);
      });

      await sendSerialText('\x05' + loader + '\r\x04');
      await ackPromise;
      // Soft reboot so main.py starts automatically
      await sleep(80);
      await sendSerialText('\x04');
      onStatus?.('Saved main.py and restarted USB board.');
      return { mode: 'main.py', bytes: utf8.length };
    } finally {
      busy = false;
    }
  }

  return {
    isSupported,
    isConnected,
    connect,
    disconnect,
    setTextHandler,
    sendSerialText,
    flashBinary,
    deployMicroPython,
    hardReset,
    // Exported for unit tests
    _internals: { slipEncode, slipDecode, espChecksum, buildCommand, parseResponse, OP_SYNC, OP_FLASH_BEGIN, OP_FLASH_DATA, OP_FLASH_END, FLASH_BLOCK_SIZE }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = window.WebSerialFlasher;
