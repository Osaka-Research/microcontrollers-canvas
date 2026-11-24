/* xtensa-esp8266.js — a from-scratch Tensilica Xtensa LX106 executor + an
 * Espressif ESP8266 SoC model, both written for emulators.org (public domain / CC0).
 *
 * The ESP8266 is a SINGLE-CORE Xtensa LX106 — the LX106 is a slightly cut-down
 * Xtensa configuration that (unlike the ESP32's dual LX6) uses the CALL0 ABI only:
 * there are NO register windows and no zero-overhead LOOP on real silicon, so the
 * bundled firmware is pure CALL0 (call0 / callx0 / ret, a0-a15).  This executor is
 * shared with the ESP32 Xtensa LX6 interpreter (the same variable-length ISA), so
 * the windowed machinery is present but simply unused by LX106 code.
 *
 * NOTHING here wraps someone else's core.  The CPU is a plain interpreter for the
 * Xtensa instruction set as the ESP8266 uses it:
 *   - the AR register file with the CALL0 (non-windowed) ABI (CALL0/CALLX0/RET);
 *   - the 24-bit and 16-bit ("narrow", density option) instruction encodings;
 *   - the core ALU / shift (SAR: SSL/SSR/SSAI + SLL/SRL/SRA) / load-store /
 *     branch set, L32R PC-relative literal loads, the 32-bit multiply (MULL);
 *   - the special registers (SAR, PS, EPC1/EXCCAUSE/EXCVADDR, CCOUNT) via RSR/WSR/XSR;
 *   - a basic exception entry (EPC1/EXCCAUSE + PS + vector) for illegal ops.
 *
 * The SoC wires up the real ESP8266 memory map at the real hardware addresses
 * (from the ESP8266 Technical Reference / the eagle_soc.h SDK headers): internal
 * SRAM on the instruction bus (IRAM 0x40100000, 32 KiB) and data bus (DRAM
 * 0x3FFE8000, 80 KiB), the cache-mapped SPI flash window (0x40200000), RTC RAM,
 * UART0 (the serial console, 0x60000000), the GPIO block (the common on-board LED
 * on GPIO2, 0x60000300), and the FRC2 / WDEV / RTC timers.  WiFi has no RF here — the
 * rest of the peripheral window is RAM-backed so firmware that probes the radio /
 * clock / watchdog registers keeps running; no packets move and the hardware WDT
 * never fires.
 *
 * Everything is plain, side-effect-inspectable JavaScript state so the shared
 * emulators.org debugger (esp8266-debug.js) can single-step it, read/write the AR
 * registers + the special registers, read the memory map without side effects, and
 * stop on execution breakpoints and write-watchpoints.
 *
 *   var sys = ESP8266.createSystem();
 *   sys.loadImage(bytes, 0x40100000); sys.setEntry(0x40100000);
 *   sys.onUartTx = function (b) { ... };      // UART0 TX -> console
 *   sys.step();                               // execute one instruction
 */
(function (root) {
  'use strict';

  // ---- ESP8266 memory map (eagle_soc.h / ESP8266 TRM, verified) ------------
  var IRAM_LOW  = 0x40100000, IRAM_HIGH = 0x40108000;   // internal SRAM, instruction bus (32 KiB)
  var DRAM_LOW  = 0x3FFE8000, DRAM_HIGH = 0x40000000;   // internal SRAM, data bus (dram0, 96 KiB; stack tops at 0x40000000)
  var IRAM_SIZE = IRAM_HIGH - IRAM_LOW;
  var DRAM_SIZE = DRAM_HIGH - DRAM_LOW;
  var IROM_LOW  = 0x40200000;                            // cache-mapped SPI flash, instruction bus
  var DROM_LOW  = 0x40200000;                            // (ESP8266 maps flash constants in the same window)
  var FLASH_SIZE = 0x100000;                             // XIP window: the cache maps the first 1 MiB of the chip
  var FLASH_CHIP_SIZE = 0x400000;                        // the SPI flash chip itself (4 MiB, as on an ESP-12), reached by SPIRead/SPIWrite
  var RTC_LOW   = 0x60001000, RTC_SIZE = 0x800;          // RTC RAM
  var PERI_LOW  = 0x60000000, PERI_HIGH = 0x60001000;    // peripheral window

  // peripheral bases within the 0x6000xxxx window
  var UART0_BASE = 0x60000000, UART1_BASE = 0x60000F00, SPI_BASE = 0x60000200, HSPI_BASE = 0x60000100;
  var FLASH_JEDEC_ID = 0x001640EF;                       // Winbond W25Q32 (EF 40 16), a 4 MiB part
  var GPIO_BASE  = 0x60000300;
  var TIMER_BASE = 0x60000600;                           // FRC1/FRC2 timers + watchdog
  var RTC_BASE   = 0x60000700;                           // RTC control
  var DPORT_BASE = 0x3FF00000;                           // (DPORT is out of the window; reads 0 / writes ignored if probed)

  var LED_GPIO = 2;                                      // common on-board LED pin (GPIO2, e.g. ESP-12 / NodeMCU)

  // ---- special-register numbers (Xtensa) -----------------------------------
  var SR_LBEG = 0, SR_LEND = 1, SR_LCOUNT = 2, SR_SAR = 3, SR_WINDOWBASE = 72,
      SR_WINDOWSTART = 73, SR_PS = 230, SR_EPC1 = 177, SR_EXCSAVE1 = 209,
      SR_EXCCAUSE = 232, SR_EXCVADDR = 238, SR_CCOUNT = 234, SR_INTENABLE = 228,
      SR_MEMCTL = 97;

  function u32(x) { return x >>> 0; }
  function sext(v, bits) { var m = 1 << (bits - 1); return ((v & ((1 << bits) - 1)) ^ m) - m; }

  // Xtensa b4const immediate table (for BEQI/BNEI/BLTI/BGEI etc.)
  var B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
  var B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];

  function createSystem(opts) {
    opts = opts || {};
    var sramI = new Uint8Array(IRAM_SIZE);   // instruction-bus internal SRAM
    var sramD = new Uint8Array(DRAM_SIZE);   // data-bus internal SRAM
    var flash = new Uint8Array(FLASH_CHIP_SIZE);
    var rtc   = new Uint8Array(RTC_SIZE);
    // DPORT block (0x3FF00000): holds the eFuse / OTP words the SDK boot reads to
    // confirm "this is an ESP8266" (base 0x3FEFFE00 + 0x250..0x25C = eFuse 0..3)
    // and to derive the MAC.  Modeled with faithful ESP8266 eFuse defaults (a valid
    // 18:fe:34 Espressif-OUI MAC; word-2 bit15 = the genuine-chip flag).
    var DPORT_LOW = 0x3FF00000, DPORT_SIZE = 0x1000;
    var dport = new Uint8Array(DPORT_SIZE);
    // peripheral backing store (word granularity), so every unmodelled register
    // behaves as plain RAM and nothing hangs on a probe (WiFi/BLE/clock/WDT).
    var peri  = new Uint32Array((PERI_HIGH - PERI_LOW) >> 2);

    // ---- CPU state ----
    var AR = new Int32Array(64);   // physical windowed register file (LX6: 64)
    var pc = 0;
    var sar = 0;                   // shift amount register (0..31, or up to 32)
    var memctl = 1;                // MEMCTL (SR 97): cache/mem control, LX106 reset value = 1
    var windowbase = 0;            // 0..15
    var windowstart = 0;           // 16-bit
    var ps = 0x40000;             // PS: start with WOE off, ring 0; PS.EXCM etc.
    var lbeg = 0, lend = 0, lcount = 0;   // zero-overhead loop registers
    var epc1 = 0, excsave1 = 0, exccause = 0, excvaddr = 0, intenable = 0;
    // The clock: `cycles` counts ticks of the 80 MHz reference (a double, so it does not wrap for
    // years). Every timer below reads it: WDEV_NOW at 1 MHz, the FRCs through their prescalers, and
    // CCOUNT at the CPU clock. An instruction costs one CPU cycle (0.5 ticks at 160 MHz), times `insnScale`,
    // which the MicroPython run loop raises while this interpreter runs slower than real time.
    var cycles = 0, instret = 0, cpuMul = 1, insnScale = 1, perInsn = 1, ccountAdj = 0;
    var halted = false;

    // PS bit fields
    var PS_INTLEVEL = 0x0000000f, PS_EXCM = 0x00000010, PS_UM = 0x00000020,
        PS_RING = 0x000000c0, PS_OWB = 0x00000f00, PS_CALLINC = 0x00030000,
        PS_WOE = 0x00040000;

    var rxfifo = [];               // UART0 RX bytes waiting for firmware
    var gpioOut = 0, gpioEnable = 0, externalMask = 0, externalValue = 0;
    var romHook = null;            // optional mask-ROM HLE trap (boot-runtime)
    var ROM_LOW = 0x40000000, ROM_HIGH = 0x40010000;
    var sys = {};

    // ---- windowed register access (visible a0..a15 -> physical) ----
    function ar(i) { return AR[((windowbase << 2) + i) & 63] | 0; }
    function setAr(i, v) { AR[((windowbase << 2) + i) & 63] = v | 0; }

    // --------------------------------------------------------------------
    // Memory bus.  regionFor returns { m, off } for a linear-RAM region, or
    // null for the peripheral window (handled specially) / unmapped.
    // --------------------------------------------------------------------
    function regionFor(a) {
      a = a >>> 0;
      if (a >= IRAM_LOW && a < IRAM_HIGH) return { m: sramI, off: a - IRAM_LOW };
      if (a >= DRAM_LOW && a < DRAM_HIGH) return { m: sramD, off: a - DRAM_LOW };
      if (a >= IROM_LOW && a < IROM_LOW + FLASH_SIZE) return { m: flash, off: a - IROM_LOW };
      if (a >= DROM_LOW && a < DROM_LOW + FLASH_SIZE) return { m: flash, off: a - DROM_LOW };
      if (a >= RTC_LOW && a < RTC_LOW + RTC_SIZE) return { m: rtc, off: a - RTC_LOW };
      if (a >= DPORT_LOW && a < DPORT_LOW + DPORT_SIZE) return { m: dport, off: a - DPORT_LOW };
      return null;
    }
    function isPeri(a) { a = a >>> 0; return a >= PERI_LOW && a < PERI_HIGH; }

    // ---- peripheral word read/write (word-aligned addr) ----
    function periRead(a) {
      a = a >>> 0;
      if (a >= UART0_BASE && a < UART0_BASE + 0x100) {
        var o = a - UART0_BASE;
        if (o === 0x00) { return rxfifo.length ? (rxfifo.shift() & 0xff) : 0; }   // UART_FIFO (RX pop)
        if (o === 0x1C) { return ((rxfifo.length & 0xff) << 0) | (0 << 16); }     // UART_STATUS: RXFIFO_CNT, TXFIFO_CNT=0
        if (o === 0x04) { return rxfifo.length ? 0x1 : 0; }                       // UART_INT_RAW: rxfifo_full-ish
        if (o === 0x08) { return rxfifo.length ? 0x1 : 0; }                       // UART_INT_ST
      }
      if (a >= GPIO_BASE && a < GPIO_BASE + 0x100) {
        var g = a - GPIO_BASE;
        if (g === 0x00) return gpioOut >>> 0;      // GPIO_OUT
        if (g === 0x0C) return gpioEnable >>> 0;   // GPIO_ENABLE
        if (g === 0x18) return gpioIn();           // GPIO_IN
      }
      // GPIO16 lives in the RTC block: RTC_GPIO_IN_DATA reads back RTC_GPIO_OUT.
      if (a === 0x6000078C) return (externalMask & 0x10000) ? ((externalValue >>> 16) & 1) : peri[(0x60000768 - PERI_LOW) >> 2] & 1;
      // RTC_SLP_CNT_VAL: the slow RTC counter behind system_get_rtc_time(), machine.RTC and time.time().
      // Its rate is what system_rtc_clock_cali_proc() works out from the measurement register below,
      // 0x7627/4096 microseconds per tick, so the guest's arithmetic gets real time back.
      if (a === 0x6000071C) return Math.floor(cycles / 80 * 4096 / 0x7627) >>> 0;
      // RTC/analog measurement status (0x60000728): the SDK phy/clock bring-up
      // polls low-2-bits for "operation done"; report done (bit0) so it proceeds.
      if (a === 0x60000728) return (peri[(a - PERI_LOW) >> 2] | 0x1) >>> 0;
      // Crystal/clock frequency-measurement register (0x60000370): bit31 = done,
      // low 28 bits = the measured count.  The SDK spins on bit31 then derives the
      // XTAL freq (40 vs 26 MHz).  Report done with a count consistent with a
      // 26 MHz crystal so clock setup completes (UART bypasses real cycle timing).
      if (a === 0x60000370) return (0x80000000 | 0x0000c000) >>> 0;
      // FRC2_COUNT (0x60000624): the free-running up-counter the SDK's os_timer list runs on.
      if (a === FRC2_COUNT) return frc2Count();
      return peri[(a - PERI_LOW) >> 2] >>> 0;      // default: RAM-backed
    }

    // Input level: a driven pin reads what it drives; an undriven pin reads its pull-up (IO_MUX bit 7).
    var IOMUX = [0x34, 0x18, 0x38, 0x14, 0x3C, 0x40, 0x1C, 0x20, 0x24, 0x28, 0x2C, 0x30, 0x04, 0x08, 0x0C, 0x10];
    function gpioIn() {
      var pulled = 0;
      for (var i = 0; i < 16; i++) if (peri[(0x60000800 + IOMUX[i] - PERI_LOW) >> 2] & 0x80) pulled |= 1 << i;
      return (((gpioOut & gpioEnable) | (~gpioEnable & ((pulled & ~externalMask) | (externalValue & externalMask)))) & 0xffff) >>> 0;
    }

    // ---- FRC2: LOAD 0x620, COUNT 0x624, CTRL 0x628 (enable bit 7, prescale in bits 3:2),
    // INT 0x62C, ALARM 0x630. Counts up from the last LOAD and interrupts (source 10) on reaching
    // ALARM; the SDK's os_timer list reprograms ALARM for its next expiry each time.
    var FRC2_LOAD = 0x60000620, FRC2_COUNT = 0x60000624, FRC2_CTRL = 0x60000628, FRC2_ALARM = 0x60000630;
    var frc2Start = 0, frc2At = 0, frc2Armed = false;      // counter value `frc2Start` as of `cycles` = frc2At
    function frc2Div() { var p = (peri[(FRC2_CTRL - PERI_LOW) >> 2] >>> 2) & 3; return p === 0 ? 1 : p === 1 ? 16 : 256; }
    function frc2Running() { return (peri[(FRC2_CTRL - PERI_LOW) >> 2] & 0x80) !== 0; }
    function frc2Count() { return frc2Running() ? (frc2Start + Math.floor((cycles - frc2At) / frc2Div())) >>> 0 : frc2Start >>> 0; }
    function frc2Set(v) { frc2Start = v >>> 0; frc2At = cycles; }

    function periWrite(a, v) {
      a = a >>> 0; v = v >>> 0;
      if (a >= UART0_BASE && a < UART0_BASE + 0x100) {
        var o = a - UART0_BASE;
        if (o === 0x00) { if (sys.onUartTx) sys.onUartTx(v & 0xff); return; }     // UART_FIFO (TX)
      }
      if (a === FRC2_LOAD) { frc2Set(v); peri[(a - PERI_LOW) >> 2] = v; return; }
      if (a === FRC2_CTRL) { var c = frc2Count(); peri[(a - PERI_LOW) >> 2] = v; frc2Set(c); return; }
      if (a === FRC2_ALARM) { peri[(a - PERI_LOW) >> 2] = v; frc2Armed = true; return; }
      // SPI0 (the flash controller): a command runs at once and its bit self-clears. RDID (bit 28)
      // leaves the JEDEC ID in W0, so spi_flash_get_id() returns instead of polling forever.
      if (a === SPI_BASE) {
        if (v & 0x10000000) peri[(SPI_BASE + 0x40 - PERI_LOW) >> 2] = FLASH_JEDEC_ID;
        peri[(a - PERI_LOW) >> 2] = 0;
        return;
      }
      // HSPI (machine.SPI(1)): nothing is attached, so a transfer is over as soon as it starts.
      if (a === HSPI_BASE) { peri[(a - PERI_LOW) >> 2] = 0; return; }
      if (a >= GPIO_BASE && a < GPIO_BASE + 0x100) {
        var g = a - GPIO_BASE;
        if (g === 0x00) { gpioOut = v; return; }              // GPIO_OUT
        if (g === 0x04) { gpioOut |= v; return; }             // GPIO_OUT_W1TS
        if (g === 0x08) { gpioOut &= ~v; return; }            // GPIO_OUT_W1TC
        if (g === 0x0C) { gpioEnable = v; return; }           // GPIO_ENABLE
        if (g === 0x10) { gpioEnable |= v; return; }          // GPIO_ENABLE_W1TS
        if (g === 0x14) { gpioEnable &= ~v; return; }         // GPIO_ENABLE_W1TC
      }
      // default: RAM-backed (UART config, FRC1/FRC2 timers + watchdog feeds, the
      // WiFi FE/BB/RTC radio+clock windows -> HLE stubs; the WDT never fires)
      peri[(a - PERI_LOW) >> 2] = v;
    }

    // ---- watchpoints: a Set of byte addresses the embed shares in ----
    // memHook/execHook (installed by esp8266-debug.js) route the debugger's byte-
    // access + instruction-boundary checks into the shared breakpoint engine.
    // Observational only: on a hit they set wpPending so the run loop pauses at the
    // boundary (same path as write-watchpoints). Null when no reg/mem breaks armed.
    var watch = null, wpPending = false;
    var memHook = null, execHook = null;
    function noteWrite(a) { if (watch && watch.size && watch.has(a >>> 0)) wpPending = true; }
    function dbgRd(a, v, w) { for (var k = 0; k < w; k++) if (memHook((a + k) >>> 0, (v >>> (8 * k)) & 0xff, 'r')) wpPending = true; }
    function dbgWr(a, v, w) { for (var k = 0; k < w; k++) if (memHook((a + k) >>> 0, (v >>> (8 * k)) & 0xff, 'w')) wpPending = true; }

    // ---- byte/half/word bus (little-endian) ----
    // WDEV_NOW (0x3FF20C00): the ESP8266 free-running 1 MHz system timer.
    // system_get_time() reads it, and MicroPython's ticks_us and sleeps are built on it.
    // WDEV_RND (0x3FF20E44): the hardware random number register, behind os.urandom and
    // the seed of the random module.
    var WDEV_NOW = 0x3FF20C00, WDEV_RND = 0x3FF20E44;
    function wdevNow() { return Math.floor(cycles / 80) >>> 0; }
    function wdevRnd() { return Math.floor(Math.random() * 0x100000000) >>> 0; }
    function read8(a) {
      a = a >>> 0; var r = regionFor(a);
      if (r) return r.m[r.off] | 0;
      if (a >= WDEV_NOW && a < WDEV_NOW + 4) return (wdevNow() >>> ((a & 3) * 8)) & 0xff;
      if (a >= WDEV_RND && a < WDEV_RND + 4) return wdevRnd() & 0xff;
      if (isPeri(a)) return (periRead(a & ~3) >>> ((a & 3) * 8)) & 0xff;
      return 0;
    }
    function read16(a) { return (read8(a) | (read8(a + 1) << 8)) & 0xffff; }
    function read32(a) {
      a = a >>> 0; var r = regionFor(a);
      if (r) { var o = r.off, m = r.m; return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0; }
      if (a === WDEV_NOW) return wdevNow() >>> 0;
      if (a === WDEV_RND) return wdevRnd();
      if (isPeri(a)) return periRead(a) >>> 0;
      return 0;
    }
    function write8(a, v) {
      a = a >>> 0; v = v & 0xff; noteWrite(a);
      var r = regionFor(a);
      if (r) { r.m[r.off] = v; return; }
      if (isPeri(a)) { var w = periRead(a & ~3), sh = (a & 3) * 8; periWrite(a & ~3, (w & ~(0xff << sh)) | (v << sh)); }
    }
    function write16(a, v) { write8(a, v & 0xff); write8(a + 1, (v >>> 8) & 0xff); }
    function write32(a, v) {
      a = a >>> 0; v = v >>> 0; noteWrite(a);
      var r = regionFor(a);
      if (r) { var o = r.off, m = r.m; m[o] = v & 0xff; m[o + 1] = (v >>> 8) & 0xff; m[o + 2] = (v >>> 16) & 0xff; m[o + 3] = (v >>> 24) & 0xff; return; }
      if (isPeri(a)) { periWrite(a, v); }
    }

    // --------------------------------------------------------------------
    // Special registers (RSR/WSR/XSR)
    // --------------------------------------------------------------------
    function srRead(n) {
      switch (n) {
        case SR_SAR: return sar >>> 0;
        case SR_LBEG: return lbeg >>> 0;
        case SR_LEND: return lend >>> 0;
        case SR_LCOUNT: return lcount >>> 0;
        case SR_WINDOWBASE: return windowbase >>> 0;
        case SR_WINDOWSTART: return windowstart >>> 0;
        case SR_PS: return ps >>> 0;
        case SR_EPC1: return epc1 >>> 0;
        case SR_EXCSAVE1: return excsave1 >>> 0;
        case SR_EXCCAUSE: return exccause >>> 0;
        case SR_EXCVADDR: return excvaddr >>> 0;
        case SR_INTENABLE: return intenable >>> 0;
        case SR_CCOUNT: return ccount();
        case SR_MEMCTL: return memctl >>> 0;
      }
      return 0;   // unmodelled SRs read as 0
    }
    function srWrite(n, v) {
      v = v >>> 0;
      switch (n) {
        case SR_SAR: sar = v & 0x3f; return;
        case SR_LBEG: lbeg = v; return;
        case SR_LEND: lend = v; return;
        case SR_LCOUNT: lcount = v; return;
        case SR_WINDOWBASE: windowbase = v & 15; return;
        case SR_WINDOWSTART: windowstart = v & 0xffff; return;
        case SR_PS: ps = v; return;
        case SR_EPC1: epc1 = v; return;
        case SR_EXCSAVE1: excsave1 = v; return;
        case SR_EXCCAUSE: exccause = v; return;
        case SR_EXCVADDR: excvaddr = v; return;
        case SR_INTENABLE: intenable = v; return;
        case SR_CCOUNT: ccountAdj = (ccountAdj + v - ccount()) >>> 0; return;
        case SR_MEMCTL: memctl = v >>> 0; return;
      }
    }
    function ccount() { return (Math.floor(cycles * cpuMul) + ccountAdj) >>> 0; }

    // ---- exception entry (illegal instruction / explicit) ----
    function raiseException(cause, vaddr) {
      epc1 = pc >>> 0;
      exccause = cause >>> 0;
      excvaddr = vaddr >>> 0;
      ps = (ps | PS_EXCM);
      // Without an installed handler we halt (bare-metal firmware here does not
      // rely on the exception vectors); the panel/debugger can inspect EXCCAUSE.
      halted = true;
    }

    // --------------------------------------------------------------------
    // The Xtensa interpreter.  execOne() runs exactly one instruction and
    // returns the byte length that was executed (2 for narrow, 3 otherwise).
    // --------------------------------------------------------------------

    // window-rotation helpers -------------------------------------------------
    function callWindowed(inc, target, retpc) {
      // CALL4/8/12 / CALLX4/8/12: store {inc, ret} into a[inc*4]; PS.CALLINC=inc.
      var reg = inc << 2;                      // a4 / a8 / a12 of the CURRENT window
      setAr(reg, ((inc << 30) | (retpc & 0x3fffffff)) | 0);
      ps = (ps & ~PS_CALLINC) | ((inc << 16) & PS_CALLINC);
      pc = target >>> 0;
    }
    function doEntry(s, framebytes) {
      var inc = (ps & PS_CALLINC) >> 16;       // 1..3
      var caller = ar(s) | 0;                  // read sp in the OLD window
      windowbase = (windowbase + inc) & 15;
      windowstart |= (1 << windowbase);
      setAr(s, (caller - framebytes) | 0);     // new sp = caller sp - frame
    }
    function doRetw() {
      var a0 = ar(0) | 0;
      var inc = (a0 >>> 30) & 3;               // CALLINC recorded at call time
      var ret = (pc & 0xc0000000) | (a0 & 0x3fffffff);
      windowstart &= ~(1 << windowbase);
      windowbase = (windowbase - inc) & 15;
      pc = ret >>> 0;
    }

    function exec24(w) {
      var op0 = w & 0xf;
      var t = (w >>> 4) & 0xf, s = (w >>> 8) & 0xf, r = (w >>> 12) & 0xf;
      var op1 = (w >>> 16) & 0xf, op2 = (w >>> 20) & 0xf;
      var next = (pc + 3) >>> 0;

      switch (op0) {
        case 0: return qrst(w, t, s, r, op1, op2, next);
        case 1: { // L32R  (RI16, negative PC-relative literal load)
          var imm16 = (w >>> 8) & 0xffff;
          // L32R literal base is (pc+3)&~3 per the ISA, not pc&~3 (differs when the
          // L32R itself is not word-aligned). Fix promoted from esp32/xtensa-esp32.js.
          var ea = ((((pc + 3) & ~3) >>> 0) + (((imm16 << 2) - 0x40000) | 0)) >>> 0;
          setAr(t, read32(ea) | 0); pc = next; return 3;
        }
        case 2: return lsai(w, t, s, r, next);
        case 5: { // CALLN: CALL0/CALL4/CALL8/CALL12 (op0=5), n selects
          var n = (w >>> 4) & 3;
          var off = sext((w >>> 6) & 0x3ffff, 18);
          var target = ((((pc & ~3) >>> 0) + 4) + (off << 2)) >>> 0;
          if (n === 0) { setAr(0, next | 0); pc = target; }     // CALL0: a0 = ret
          else { callWindowed(n, target, next); }               // CALL4/8/12
          return 3;
        }
        case 6: return si(w, t, s, r, next);
        case 7: return brri8(w, t, s, r, next);
        default: raiseException(0, w); return 3;   // IllegalInstruction
      }
    }

    // op0 == 0 : QRST group (computational, dispatched by op1/op2/r)
    function qrst(w, t, s, r, op1, op2, next) {
      if (op1 === 0) {                 // ---- RST0 ----
        switch (op2) {
          case 0: return st0(w, t, s, r, next);
          case 1: setAr(r, ar(s) & ar(t)); pc = next; return 3;                  // AND
          case 2: setAr(r, ar(s) | ar(t)); pc = next; return 3;                  // OR
          case 3: setAr(r, ar(s) ^ ar(t)); pc = next; return 3;                  // XOR
          case 4: return st1(w, t, s, r, next);
          case 5: {   // TLB group (WITLB/WDTLB/RITLB/RDTLB/IITLB/IDTLB/PITLB/PDTLB).
            // Flash is direct-mapped, so writes/invalidates are no-ops and reads/
            // probes report identity (vaddr). (5th ISA fix, ported from esp32.)
            if (r === 3 || r === 7 || r === 11 || r === 15 || r === 5 || r === 13) setAr(t, ar(s) >>> 0);
            pc = next; return 3;
          }
          case 6: {                                                              // RT0: NEG/ABS (dest r, src t; s selects)
            if (s === 0) setAr(r, (-(ar(t) | 0)) | 0);                           // NEG ar, at
            else { var v = ar(t) | 0; setAr(r, (v < 0 ? -v : v) | 0); }          // ABS ar, at
            pc = next; return 3;
          }
          case 8: setAr(r, (ar(s) + ar(t)) | 0); pc = next; return 3;            // ADD
          case 9: setAr(r, ((ar(s) << 1) + ar(t)) | 0); pc = next; return 3;     // ADDX2
          case 10: setAr(r, ((ar(s) << 2) + ar(t)) | 0); pc = next; return 3;    // ADDX4
          case 11: setAr(r, ((ar(s) << 3) + ar(t)) | 0); pc = next; return 3;    // ADDX8
          case 12: setAr(r, (ar(s) - ar(t)) | 0); pc = next; return 3;           // SUB
          case 13: setAr(r, ((ar(s) << 1) - ar(t)) | 0); pc = next; return 3;    // SUBX2
          case 14: setAr(r, ((ar(s) << 2) - ar(t)) | 0); pc = next; return 3;    // SUBX4
          case 15: setAr(r, ((ar(s) << 3) - ar(t)) | 0); pc = next; return 3;    // SUBX8
        }
      } else if (op1 === 1) {          // ---- RST1: shifts + XSR ----
        switch (op2) {
          case 0: case 1: {            // SLLI  (sa = 32 - {op2[0],t}) ... amount in {op2,t}
            var samt = (((op2 & 1) << 4) | t); var sh = (32 - samt) & 31;
            setAr(r, (ar(s) << sh) | 0); pc = next; return 3;
          }
          case 2: case 3: {            // SRAI  (sa = {op2[0],s}, src in t)
            var sa2 = (((op2 & 1) << 4) | s) & 31;
            setAr(r, (ar(t) >> sa2) | 0); pc = next; return 3;
          }
          case 4: {                    // SRLI  (sa = s, src in t)  [0..15]
            setAr(r, (ar(t) >>> s) | 0); pc = next; return 3;
          }
          case 6: {                    // XSR at, sr : swap
            var srn = (w >>> 8) & 0xff, old = srRead(srn);
            srWrite(srn, ar(t) >>> 0); setAr(t, old | 0); pc = next; return 3;
          }
          // SAR runs 0..32, and both ends mean something: SSL of 0 leaves SAR=32, so these shift by
          // the whole word. GCC's 64-bit shifts and the soft-float code depend on it.
          case 9: setAr(r, sar >= 32 ? 0 : ((ar(t) >>> sar) | 0)); pc = next; return 3;   // SRL (by SAR)
          case 10: setAr(r, sar === 0 ? 0 : (ar(s) << (32 - sar))); pc = next; return 3;  // SLL (by 32-SAR)
          case 11: setAr(r, ar(t) >> (sar >= 32 ? 31 : sar)); pc = next; return 3;        // SRA (by SAR)
          case 8: {                    // SRC ar,as,at : funnel {as,at} right by SAR
            var srcHi = ar(s), srcLo = ar(t);
            setAr(r, sar === 0 ? srcLo : (sar >= 32 ? srcHi : ((srcLo >>> sar) | (srcHi << (32 - sar))))); pc = next; return 3;
          }
          case 12: setAr(r, (((ar(s) & 0xffff) * (ar(t) & 0xffff)) >>> 0) | 0); pc = next; return 3; // MUL16U (unsigned 16x16)
          case 13: setAr(r, (Math.imul((ar(s) << 16 >> 16), (ar(t) << 16 >> 16))) | 0); pc = next; return 3; // MUL16S (signed 16x16)
        }
      } else if (op1 === 4 || op1 === 5) {  // ---- EXTUI ar,at,shiftimm,maskimm ----
        // dest=r, src=t, shiftimm={op1[0],s} (5b), maskimm=op2+1 (width 1..16).
        // Fix promoted from esp32/xtensa-esp32.js.
        var shx = (((op1 & 1) << 4) | s) & 31;
        var wdt = op2 + 1;
        var msk = (wdt >= 32) ? 0xffffffff : (((1 << wdt) - 1) >>> 0);
        setAr(r, ((ar(t) >>> shx) & msk) >>> 0); pc = next; return 3;
      } else if (op1 === 2) {          // ---- RST2: 32-bit multiply ----
        switch (op2) {
          case 8: setAr(r, Math.imul(ar(s), ar(t)) | 0); pc = next; return 3;    // MULL
          case 10: setAr(r, mulhu(ar(s), ar(t)) | 0); pc = next; return 3;       // MULUH
          case 11: setAr(r, mulhs(ar(s), ar(t)) | 0); pc = next; return 3;       // MULSH
        }
      } else if (op1 === 3) {          // ---- RST3: RSR/WSR + conditional moves ----
        switch (op2) {
          case 0: { var n0 = (w >>> 8) & 0xff; setAr(t, srRead(n0) | 0); pc = next; return 3; } // RSR
          case 1: { var n1 = (w >>> 8) & 0xff; srWrite(n1, ar(t) >>> 0); pc = next; return 3; } // WSR
          case 8: if (ar(t) === 0) setAr(r, ar(s)); pc = next; return 3;         // MOVEQZ
          case 9: if (ar(t) !== 0) setAr(r, ar(s)); pc = next; return 3;         // MOVNEZ
          case 10: if ((ar(t) | 0) < 0) setAr(r, ar(s)); pc = next; return 3;    // MOVLTZ
          case 11: if ((ar(t) | 0) >= 0) setAr(r, ar(s)); pc = next; return 3;   // MOVGEZ
        }
      }
      raiseException(0, w); return 3;
    }

    // op1=0, op2=0 : ST0  (r selects; SNM0/MOVSP/SYNC/RFE/BREAK)
    function st0(w, t, s, r, next) {
      if (r === 0) {                   // SNM0: RET/RETW/JX/CALLX (m,n select)
        var m = (w >>> 6) & 3, n = (w >>> 4) & 3;
        if (m === 0 && n === 0) { raiseException(0, w); return 3; }              // ILL
        if (m === 2) {
          if (n === 0) { pc = (ar(0) & 0xffffffff) >>> 0; return 3; }            // RET (a0)
          if (n === 1) { doRetw(); return 3; }                                  // RETW
          if (n === 2) { pc = (ar(s)) >>> 0; return 3; }                        // JX
        }
        if (m === 3) {                 // CALLX0/4/8/12
          var target = ar(s) >>> 0;
          // A register-indirect call to a target below all code regions
          // (< 0x40000000) is an unpopulated callback slot — on the ESP8266 these
          // are the WiFi pp/phy/modem-sleep vtable hooks that only a live radio
          // fills in.  With no RF here they are empty, so the call is a no-op that
          // returns immediately (guards a null-pointer jump to 0).
          if (target < 0x40000000) { pc = next; return 3; }
          if (n === 0) { setAr(0, next | 0); pc = target; }                     // CALLX0
          else { callWindowed(n, target, next); }                              // CALLX4/8/12
          return 3;
        }
        raiseException(0, w); return 3;
      }
      if (r === 1) { setAr(t, ar(s)); pc = next; return 3; }                     // MOVSP (simplified: mov)
      if (r === 2) { pc = next; return 3; }                                     // SYNC group (ISYNC/RSYNC/MEMW/NOP) -> nop
      if (r === 3) {                   // RFE/RFI (return from exception)
        ps = ps & ~PS_EXCM; pc = epc1 >>> 0; return 3;
      }
      if (r === 6) {                   // RSIL at, imm : read PS, then set PS.INTLEVEL
        setAr(t, ps | 0); ps = ((ps & ~PS_INTLEVEL) | (s & PS_INTLEVEL)) >>> 0; pc = next; return 3;
      }
      if (r === 7) {                   // WAITI imm : sets PS.INTLEVEL; execution carries on at once here
        ps = ((ps & ~PS_INTLEVEL) | (s & PS_INTLEVEL)) >>> 0; pc = next; return 3;
      }
      pc = next; return 3;             // BREAK/SYSCALL/other -> nop here
    }

    // op1=0, op2=4 : ST1  (r selects SSR/SSL/SSAI/...)
    function st1(w, t, s, r, next) {
      if (r === 0) { sar = (ar(s) & 31); pc = next; return 3; }                  // SSR  : SAR = as & 31
      if (r === 1) { sar = (32 - (ar(s) & 31)) & 0x3f; pc = next; return 3; }    // SSL  : SAR = 32 - (as & 31)
      if (r === 2) { sar = ((ar(s) & 3) << 3) & 0x3f; pc = next; return 3; }     // SSA8L : SAR = 8*(as&3) (little-endian unaligned byte/half extract via SRL/SRC)
      if (r === 3) { sar = (32 - ((ar(s) & 3) << 3)) & 0x3f; pc = next; return 3; } // SSA8B : SAR = 32 - 8*(as&3) (big-endian)
      if (r === 4) { sar = (((t & 1) << 4) | s) & 0x3f; pc = next; return 3; }   // SSAI : SAR = imm (5-bit {t0,s})
      if (r === 14) {                                                            // NSA at, as : signed normalize (leading sign-bit count)
        var vn = ar(s) | 0, nn;
        if (vn === 0 || vn === -1) nn = 31;
        else nn = (Math.clz32(vn >= 0 ? vn : ~vn) - 1);
        setAr(t, nn | 0); pc = next; return 3;
      }
      if (r === 15) {                                                            // NSAU at, as : unsigned normalize (count leading zeros)
        var vu = ar(s) >>> 0;
        setAr(t, (vu === 0 ? 32 : Math.clz32(vu)) | 0); pc = next; return 3;
      }
      if (r === 8) { windowbase = (windowbase + (t << 28 >> 28)) & 15; pc = next; return 3; } // ROTW imm4 : windowbase += sext4(imm4)
      pc = next; return 3;
    }

    // op0 == 2 : LSAI group (loads/stores + MOVI/ADDI/ADDMI, r selects)
    function lsai(w, t, s, r, next) {
      var imm8 = (w >>> 16) & 0xff;
      var base = ar(s) | 0;
      switch (r) {
        case 0: setAr(t, read8((base + imm8) >>> 0) & 0xff); if (memHook) dbgRd((base + imm8) >>> 0, ar(t) & 0xff, 1); pc = next; return 3;               // L8UI
        case 1: setAr(t, read16((base + (imm8 << 1)) >>> 0) & 0xffff); if (memHook) dbgRd((base + (imm8 << 1)) >>> 0, ar(t) & 0xffff, 2); pc = next; return 3;     // L16UI
        case 2: setAr(t, read32((base + (imm8 << 2)) >>> 0) | 0); if (memHook) dbgRd((base + (imm8 << 2)) >>> 0, ar(t) >>> 0, 4); pc = next; return 3;          // L32I
        case 4: write8((base + imm8) >>> 0, ar(t) & 0xff); if (memHook) dbgWr((base + imm8) >>> 0, ar(t) & 0xff, 1); pc = next; return 3;                 // S8I
        case 5: write16((base + (imm8 << 1)) >>> 0, ar(t) & 0xffff); if (memHook) dbgWr((base + (imm8 << 1)) >>> 0, ar(t) & 0xffff, 2); pc = next; return 3;       // S16I
        case 6: write32((base + (imm8 << 2)) >>> 0, ar(t) >>> 0); if (memHook) dbgWr((base + (imm8 << 2)) >>> 0, ar(t) >>> 0, 4); pc = next; return 3;          // S32I
        case 9: setAr(t, sext(read16((base + (imm8 << 1)) >>> 0), 16) | 0); if (memHook) dbgRd((base + (imm8 << 1)) >>> 0, ar(t) & 0xffff, 2); pc = next; return 3; // L16SI
        case 10: {                                                                             // MOVI (12-bit)
          var imm12 = sext(((s << 8) | imm8), 12); setAr(t, imm12 | 0); pc = next; return 3;
        }
        case 12: setAr(t, (base + sext(imm8, 8)) | 0); pc = next; return 3;                     // ADDI
        case 13: setAr(t, (base + (sext(imm8, 8) << 8)) | 0); pc = next; return 3;              // ADDMI
        default: raiseException(0, w); return 3;
      }
    }

    // op0 == 6 : SI group (J / branches on zero / ENTRY / LOOP / BI0)
    function si(w, t, s, r, next) {
      var n = (w >>> 4) & 3, m = (w >>> 6) & 3;
      if (n === 0) {                   // J : 18-bit signed byte offset
        var off = sext((w >>> 6) & 0x3ffff, 18);
        pc = (pc + 4 + off) >>> 0; return 3;
      }
      if (n === 1) {                   // BZ : BEQZ/BNEZ/BLTZ/BGEZ (12-bit offset)
        var imm12 = sext((w >>> 12) & 0xfff, 12);
        var v = ar(s) | 0, take = false;
        if (m === 0) take = (v === 0);          // BEQZ
        else if (m === 1) take = (v !== 0);     // BNEZ
        else if (m === 2) take = (v < 0);       // BLTZ
        else take = (v >= 0);                   // BGEZ
        pc = take ? ((pc + 4 + imm12) >>> 0) : next; return 3;
      }
      if (n === 2) {                   // BI0 : BEQI/BNEI/BLTI/BGEI (8-bit offset, b4const in r)
        var off8 = sext((w >>> 16) & 0xff, 8);
        var c = B4CONST[r], v2 = ar(s) | 0, take2 = false;
        if (m === 0) take2 = (v2 === c);        // BEQI
        else if (m === 1) take2 = (v2 !== c);   // BNEI
        else if (m === 2) take2 = (v2 < c);     // BLTI
        else take2 = (v2 >= c);                 // BGEI
        pc = take2 ? ((pc + 4 + off8) >>> 0) : next; return 3;
      }
      // n === 3
      if (m === 0) {                   // ENTRY as, imm (frame = imm12 << 3)
        var frame = ((w >>> 12) & 0xfff) << 3;
        doEntry(s, frame); pc = next; return 3;
      }
      // BRI12 sub-group; m: 0=ENTRY, 1=B1[BF/BT/LOOP], 2=BLTUI, 3=BGEUI (b4constu
      // index = r). Fix promoted from esp32/xtensa-esp32.js (was LOOP at m=2 and
      // BLTUI/BGEUI crammed at m=3).
      if (m === 1) {
        if ((r & 0xf) >= 8) {          // LOOP(8)/LOOPNEZ(9)/LOOPGTZ(10)
          var off2 = (w >>> 16) & 0xff;
          var le = (pc + 4 + off2) >>> 0;
          var cnt = ar(s) | 0, skip = false, setc = cnt, lv = r & 0xf;
          if (lv === 8) { setc = cnt - 1; }                           // LOOP
          else if (lv === 9) { if (cnt === 0) skip = true; setc = cnt - 1; }  // LOOPNEZ
          else { if (cnt <= 0) skip = true; setc = cnt - 1; }         // LOOPGTZ
          lbeg = next; lend = le; lcount = setc >>> 0;
          pc = skip ? le : next; return 3;
        }
        // BF(r=0)/BT(r=1): boolean registers not modelled in this core -> not-taken.
        pc = next; return 3;
      }
      if (m === 2) {                   // BLTUI as, b4constu[r], label
        var off3 = sext((w >>> 16) & 0xff, 8);
        var cu = B4CONSTU[r] >>> 0, vu = ar(s) >>> 0;
        pc = (vu < cu) ? ((pc + 4 + off3) >>> 0) : next; return 3;
      }
      // m === 3: BGEUI as, b4constu[r], label
      var off4 = sext((w >>> 16) & 0xff, 8);
      var cu2 = B4CONSTU[r] >>> 0, vu2 = ar(s) >>> 0;
      pc = (vu2 >= cu2) ? ((pc + 4 + off4) >>> 0) : next; return 3;
    }

    // op0 == 7 : B group (register-register conditional branches, RRI8)
    function brri8(w, t, s, r, next) {
      var off = sext((w >>> 16) & 0xff, 8);
      var as = ar(s) | 0, at = ar(t) | 0, take = false;
      switch (r) {
        case 0: take = ((as & at) === 0); break;          // BNONE
        case 1: take = (as === at); break;                // BEQ
        case 2: take = (as < at); break;                  // BLT
        case 3: take = ((as >>> 0) < (at >>> 0)); break;  // BLTU
        case 4: take = ((as & at) === at); break;         // BALL
        case 5: take = (((as >>> (at & 31)) & 1) === 0); break; // BBC
        case 6: case 7: take = (((as >>> (bbi(w))) & 1) === 0); break;  // BBCI (bit4 = r&1)
        case 8: take = ((as & at) !== 0); break;          // BANY
        case 9: take = (as !== at); break;                // BNE
        case 10: take = (as >= at); break;                // BGE
        case 11: take = ((as >>> 0) >= (at >>> 0)); break;// BGEU
        case 12: take = ((as & at) !== at); break;        // BNALL
        case 13: take = (((as >>> (at & 31)) & 1) === 1); break; // BBS
        case 14: case 15: take = (((as >>> (bbi(w))) & 1) === 1); break;  // BBSI (bit4 = r&1)
        default: raiseException(0, w); return 3;
      }
      pc = take ? ((pc + 4 + off) >>> 0) : next; return 3;
    }
    function bbi(w) { return (((w >>> 12) & 1) << 4) | ((w >>> 4) & 0xf); }   // BBCI/BBSI 5-bit index {r0,t}

    // --------------------------------------------------------------------
    // 16-bit narrow (density) instructions
    // --------------------------------------------------------------------
    function exec16(h) {
      var op0 = h & 0xf;
      var t = (h >>> 4) & 0xf, s = (h >>> 8) & 0xf, r = (h >>> 12) & 0xf;
      var next = (pc + 2) >>> 0;
      switch (op0) {
        case 8: setAr(t, read32((ar(s) + (r << 2)) >>> 0) | 0); if (memHook) dbgRd((ar(s) + (r << 2)) >>> 0, ar(t) >>> 0, 4); pc = next; return 2;   // L32I.N
        case 9: write32((ar(s) + (r << 2)) >>> 0, ar(t) >>> 0); if (memHook) dbgWr((ar(s) + (r << 2)) >>> 0, ar(t) >>> 0, 4); pc = next; return 2;   // S32I.N
        case 10: setAr(r, (ar(s) + ar(t)) | 0); pc = next; return 2;                   // ADD.N
        case 11: { var im = (t === 0) ? -1 : t; setAr(r, (ar(s) + im) | 0); pc = next; return 2; } // ADDI.N
        case 12: {                                                                     // ST2: MOVI.N / BEQZ.N / BNEZ.N
          if ((t & 0x8) === 0) {                                                       // MOVI.N ar, imm7 (dest=s)
            var imm7 = ((t & 0x7) << 4) | (r & 0xf);                                   // imm = {t[2:0], r}
            if (imm7 >= 0x60) imm7 -= 0x80;                                            // -32..95
            setAr(s, imm7 | 0); pc = next; return 2;
          } else {                                                                     // BEQZ.N (t&4==0) / BNEZ.N (t&4)
            var off6 = ((t & 0x3) << 4) | (r & 0xf);                                   // 6-bit unsigned offset
            var v = ar(s) | 0, take = (t & 0x4) ? (v !== 0) : (v === 0);
            pc = take ? ((pc + 4 + off6) >>> 0) : next; return 2;
          }
        }
        case 13: {                                                                     // ST3: MOV.N / RET.N / NOP.N / ...
          if (r === 0) { setAr(t, ar(s) | 0); pc = next; return 2; }                   // MOV.N
          if (r === 15) {
            if (t === 0) { pc = (ar(0)) >>> 0; return 2; }                             // RET.N
            if (t === 1) { doRetw(); return 2; }                                       // RETW.N
            pc = next; return 2;                                                       // NOP.N / BREAK.N -> nop
          }
          pc = next; return 2;
        }
        default: raiseException(0, h); return 2;
      }
    }

    // ---- 32x32 high multiply helpers ----
    function mulhu(a, b) { return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) >>> 0; }
    function mulhs(a, b) { return Number((BigInt(a | 0) * BigInt(b | 0)) >> 32n) | 0; }

    // ---- one instruction: fetch, decode width, execute, LOOP wrap ----
    function execOne() {
      // mask-ROM HLE trap: when execution enters the boot-ROM window and a hook
      // is installed, run the clean-room HLE for that address and return via a0.
      if (romHook && (pc >>> 0) >= ROM_LOW && (pc >>> 0) < ROM_HIGH) {
        var jumped = romHook(pc >>> 0);      // HLE the ROM function
        if (!jumped) pc = ar(0) >>> 0;        // default: CALL0 return via a0
        cycles += perInsn; instret++;
        return 1;
      }
      var b0 = read8(pc);
      var op0 = b0 & 0xf;
      var len;
      if (op0 >= 8 && op0 <= 13) {     // narrow (16-bit): density only for op0 8..13 (14/15 are 3-byte)
        var h = (b0 | (read8(pc + 1) << 8)) & 0xffff;
        len = exec16(h);
      } else {
        var w = (b0 | (read8(pc + 1) << 8) | (read8(pc + 2) << 16)) >>> 0;
        len = exec24(w);
      }
      // zero-overhead LOOP: when PC reaches LEND and LCOUNT != 0, branch to LBEG.
      if (lcount !== 0 && (pc >>> 0) === (lend >>> 0)) { lcount = (lcount - 1) >>> 0; pc = lbeg >>> 0; }
      cycles += perInsn; instret++;
      return len;
    }

    function step() {
      if (halted) return 0;
      wpPending = false;
      var r = execOne();
      if (execHook && execHook()) wpPending = true;   // instruction-boundary exec/reg break
      return r;
    }

    // --------------------------------------------------------------------
    // Loading / control
    // --------------------------------------------------------------------
    function write8Raw(a, v) {
      var r = regionFor(a >>> 0);
      if (r) { r.m[r.off] = v & 0xff; return; }
      if (isPeri(a)) periWrite((a & ~3) >>> 0, (periRead(a & ~3) & ~(0xff << ((a & 3) * 8))) | ((v & 0xff) << ((a & 3) * 8)));
    }
    function loadImage(bytes, addr) {
      addr = addr >>> 0;
      for (var i = 0; i < bytes.length; i++) write8Raw(addr + i, bytes[i]);
    }
    function setEntry(a) { pc = a >>> 0; }
    // keepRtc: a restart from inside, which leaves the RTC block's registers alone. The SDK's
    // system_restart keeps the reset reason in one (0x60000730), for the next boot to find.
    function reset(keepRtc) {
      var rtcRegs = keepRtc === true ? peri.slice((RTC_BASE - PERI_LOW) >> 2, (RTC_BASE + 0x100 - PERI_LOW) >> 2) : null;
      AR.fill(0); pc = 0; sar = 0; windowbase = 0; windowstart = 1; ps = 0x40000;
      lbeg = 0; lend = 0; lcount = 0; epc1 = 0; excsave1 = 0; exccause = 0; excvaddr = 0; intenable = 0;
      cycles = 0; instret = 0; halted = false; cpuMul = 1; insnScale = 1; perInsn = 1; ccountAdj = 0;
      frc2Start = 0; frc2At = 0; frc2Armed = false;
      gpioOut = 0; gpioEnable = 0; rxfifo.length = 0; peri.fill(0);
      if (rtcRegs) peri.set(rtcRegs, (RTC_BASE - PERI_LOW) >> 2);
      // eFuse / OTP defaults so the SDK chip-ID guard passes and the derived MAC
      // is a valid 18:FE:34:AB:CD:EF (Espressif OUI).  word2 bit15 = genuine flag.
      dport.fill(0);
      function dp32(off, v) { dport[off] = v & 0xff; dport[off+1] = (v>>>8)&0xff; dport[off+2] = (v>>>16)&0xff; dport[off+3] = (v>>>24)&0xff; }
      dp32(0x050, 0xEF000000);   // eFuse0: MAC low byte 0xEF (nonzero -> not "empty otp")
      dp32(0x054, 0x0000ABCD);   // eFuse1: OUI-select 0 (18:FE:34) + MAC bytes AB CD
      dp32(0x058, 0x00008000);   // eFuse2: bit15 = "genuine ESP8266" flag
      dp32(0x05C, 0x00000000);   // eFuse3: 0 -> use default OUI
    }

    // ---- assemble the public system object ----
    reset();
    sys.AR = AR;
    sys.step = step;
    sys.reset = reset;
    sys.loadImage = loadImage;
    sys.setEntry = setEntry;
    sys.getPc = function () { return pc >>> 0; };
    sys.setPc = function (v) { pc = v >>> 0; };
    sys.getCycles = function () { return ccount(); };
    sys.getUs = function () { return cycles / 80; };           // emulated microseconds since reset
    sys.setCpuMhz = function (m) { cpuMul = m >= 160 ? 2 : 1; perInsn = insnScale / cpuMul; };
    sys.setInsnScale = function (k) { insnScale = k; perInsn = insnScale / cpuMul; };
    sys.getInstret = function () { return instret; };
    sys.frc2Due = function () { return frc2Armed && frc2Running() && ((frc2Count() - peri[(FRC2_ALARM - PERI_LOW) >> 2]) | 0) >= 0; };
    sys.frc2Ack = function () { frc2Armed = false; };
    sys.isHalted = function () { return halted; };
    sys.ar = ar; sys.setAr = setAr;
    // live special-register accessors for the debugger (read + write-back)
    sys.sr = {
      get sar() { return sar >>> 0; }, set sar(v) { sar = v & 0x3f; },
      get windowbase() { return windowbase >>> 0; }, set windowbase(v) { windowbase = v & 15; },
      get windowstart() { return windowstart >>> 0; }, set windowstart(v) { windowstart = v & 0xffff; },
      get ps() { return ps >>> 0; }, set ps(v) { ps = v >>> 0; },
      get lbeg() { return lbeg >>> 0; }, set lbeg(v) { lbeg = v >>> 0; },
      get lend() { return lend >>> 0; }, set lend(v) { lend = v >>> 0; },
      get lcount() { return lcount >>> 0; }, set lcount(v) { lcount = v >>> 0; },
      get epc1() { return epc1 >>> 0; }, set epc1(v) { epc1 = v >>> 0; },
      get exccause() { return exccause >>> 0; }, set exccause(v) { exccause = v >>> 0; },
      get excvaddr() { return excvaddr >>> 0; }, set excvaddr(v) { excvaddr = v >>> 0; }
    };
    sys.read8 = read8; sys.read16 = read16; sys.read32 = read32;
    sys.write8 = write8; sys.write16 = write16; sys.write32 = write32;
    sys.srRead = srRead; sys.srWrite = srWrite;
    sys.setExternalInputs = function(mask, value) { externalMask = mask >>> 0; externalValue = value >>> 0; };
    sys.gpio = { get out() { return gpioOut >>> 0; }, get enable() { return gpioEnable >>> 0; } };
    sys.ledOn = function () { return ((gpioOut >>> LED_GPIO) & 1) === 1 && ((gpioEnable >>> LED_GPIO) & 1) === 1; };
    sys.ledPin = LED_GPIO;
    sys.feedRx = function (byte) { rxfifo.push(byte & 0xff); };
    sys.rxfifoLen = function () { return rxfifo.length; };
    sys.setRomHook = function (fn) { romHook = fn; };
    sys.setSp = function (v) { setAr(1, v | 0); };
    sys.addUs = function (us) { cycles += us * 80; };          // time passing without instructions (a ROM delay, the wall clock)
    sys.setPeri = function (a, v) { periWrite(a >>> 0, v >>> 0); };
    sys.getPeri = function (a) { return periRead(a >>> 0) >>> 0; };
    sys.setWatch = function (set) { watch = set; };
    sys.wpHit = function () { return wpPending; };
    // debugger hooks (installed by esp8266-debug.js; each returns true on a break hit)
    sys.setMemHook = function (fn) { memHook = fn; };
    sys.setExecHook = function (fn) { execHook = fn; };
    sys.execCheck = function () { return !!(execHook && execHook()); };
    // live SoC peripheral-register snapshots for the debugger Devices window
    sys.dbg = {
      gpio: function () { return { out: gpioOut >>> 0, en: gpioEnable >>> 0, led: (gpioOut >>> LED_GPIO) & 1, ledEn: (gpioEnable >>> LED_GPIO) & 1 }; },
      uart: function () { return { rx: rxfifo.length | 0, status: (rxfifo.length & 0xff) >>> 0 }; },
      timer: function () { return { us: wdevNow(), frc2: frc2Count(), frc1: peri[((TIMER_BASE - PERI_LOW) >> 2)] >>> 0 }; },
      intc: function () { return { intenable: intenable >>> 0, intlevel: (ps & 0xf) >>> 0 }; },
      radio: function () { return { wifi: peri[((0x60000700 - PERI_LOW) >> 2)] >>> 0, w2: peri[((0x60000780 - PERI_LOW) >> 2)] >>> 0 }; }
    };
    sys.onUartTx = null;
    sys.map = {
      IRAM_LOW: IRAM_LOW, IRAM_HIGH: IRAM_HIGH, IRAM_SIZE: IRAM_SIZE,
      DRAM_LOW: DRAM_LOW, DRAM_HIGH: DRAM_HIGH, DRAM_SIZE: DRAM_SIZE,
      IROM_LOW: IROM_LOW, DROM_LOW: DROM_LOW, FLASH_SIZE: FLASH_SIZE, FLASH_CHIP_SIZE: FLASH_CHIP_SIZE,
      FLASH_JEDEC_ID: FLASH_JEDEC_ID,
      RTC_LOW: RTC_LOW, RTC_SIZE: RTC_SIZE,
      PERI_LOW: PERI_LOW, PERI_HIGH: PERI_HIGH, UART0_BASE: UART0_BASE, GPIO_BASE: GPIO_BASE,
      TIMER_BASE: TIMER_BASE, LED_GPIO: LED_GPIO
    };
    sys.mem = { sramI: sramI, sramD: sramD, flash: flash, rtc: rtc };
    return sys;
  }

  var ESP8266 = { createSystem: createSystem };
  if (typeof module !== 'undefined' && module.exports) module.exports = ESP8266;
  if (root) root.ESP8266 = ESP8266;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
