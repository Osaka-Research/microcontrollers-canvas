/* rom8266.js — clean-room HLE of the ESP8266 mask-ROM (eagle.rom.addr.v6) funcs
 * the NONOS SDK + MicroPython boot path calls, plus the NONOS os_task scheduler
 * (ets_task/ets_post/ets_run) and interrupt-driven UART0 RX delivery.
 *
 * Written from public ABI/behaviour + the public ROM symbol addresses only; no
 * ROM code is copied.  Xtensa CALL0 ABI: args a2..a7, return value in a2.
 */
(function (root) {
  'use strict';

  function makeRomHle(env) {
    var sys = env.sys, uartPut = env.uartPut, log = env.log || function () {};
    var A = function (i) { return sys.ar(2 + i) | 0; };            // a2..a7 = args 0..5
    var setRet = function (v) { sys.setAr(2, v | 0); };
    function stkArg(n) { var sp = sys.ar(1) >>> 0; return sys.read32((sp + (n - 6) * 4) >>> 0) | 0; }
    function argN(n) { return n < 6 ? (sys.ar(2 + n) | 0) : stkArg(n); }
    function readStr(p) { p >>>= 0; var s = '', b; while ((b = sys.read8(p++))) s += String.fromCharCode(b); return s; }
    function emit(str) { for (var k = 0; k < str.length; k++) uartPut(str.charCodeAt(k) & 0xff); }

    // ---- ROM addresses that need special dispatch (scheduler / call trampolines) ----
    var ETS_RUN = 0x40000e04;
    var CALL_SENTINEL = 0x4000fffc;    // unused ROM word; callGuest returns here
    var IRQ_RETURN = 0x4000fff8;       // unused ROM word; an interrupt handler returns here
    var EVT_SCRATCH = 0x600017f0;       // top of RTC RAM: ETSEvent {sig,par} handed to tasks
    var SR_INTENABLE = 228;
    var INT_UART = 5, INT_FRC1 = 9, INT_FRC2 = 10;    // ETS_UART_INUM, FRC1 (PWM), FRC2 (os_timer)

    // ---- os_task scheduler state ----
    var tasks = {};                     // prio -> { fn: addr }
    var pend = [];                      // FIFO of { prio, sig, par }
    // ---- interrupt state ----
    var isr = {};                       // intno -> { fn, arg }
    var irqCtx = null;                  // the context an interrupt handler will return to
    // ---- reset / clock state ----
    var cpuMhz = 80;
    var resetReason = 1;                // rtc_get_reset_reason: 1 power-on, 2 reset from inside

    // Run a guest CALL0 function to completion (save/restore full context).
    function callGuest(fn, a2, a3) {
      var savePc = sys.getPc() >>> 0;
      var save = []; for (var i = 0; i < 16; i++) save[i] = sys.ar(i) | 0;
      var saveSar = sys.sr.sar, savePs = sys.sr.ps;
      sys.setAr(0, CALL_SENTINEL);
      sys.setAr(2, a2 | 0); sys.setAr(3, a3 | 0);
      sys.setPc(fn >>> 0);
      var guard = 0;
      while ((sys.getPc() >>> 0) !== (CALL_SENTINEL >>> 0) && guard++ < 4000000) {
        if (sys.isHalted()) break;
        sys.step();
      }
      var ret = sys.ar(2) | 0;
      for (var j = 0; j < 16; j++) sys.setAr(j, save[j]);
      sys.sr.sar = saveSar; sys.sr.ps = savePs;
      sys.setPc(savePc);
      return ret;
    }

    // Enter a level-1 interrupt handler the way the ROM's dispatcher would: the interrupted context
    // is saved, PS.EXCM masks further interrupts, and the handler's return lands on IRQ_RETURN. It runs
    // on the normal step loop, so it can be single-stepped and hit breakpoints like any other code.
    function enterIsr(intno) {
      var h = isr[intno], regs = [];
      for (var i = 0; i < 16; i++) regs[i] = sys.ar(i) | 0;
      irqCtx = { pc: sys.getPc() >>> 0, regs: regs, sar: sys.sr.sar, ps: sys.sr.ps };
      sys.sr.ps = (sys.sr.ps | 0x10) >>> 0;          // PS.EXCM
      sys.setAr(0, IRQ_RETURN);
      sys.setAr(2, h.arg | 0); sys.setAr(3, 0);
      sys.setPc(h.fn >>> 0);
    }
    function irqReturn() {
      var c = irqCtx; irqCtx = null;
      for (var i = 0; i < 16; i++) sys.setAr(i, c.regs[i]);
      sys.sr.sar = c.sar; sys.sr.ps = c.ps;
      sys.setPc(c.pc);
    }
    // Take one pending interrupt, if any is allowed: a source fires only if the guest has attached a
    // handler and enabled it in INTENABLE, and only outside handlers and critical sections.
    // Sources: FRC2 reaching its alarm (the os_timer list) and UART0 RX.
    var UART0 = 0x60000000;
    function pumpIrq() {
      if (irqCtx) return false;
      var ps = sys.sr.ps;
      if ((ps & 0x10) || (ps & 0xf) >= 1) return false;
      var en = sys.srRead(SR_INTENABLE) >>> 0;
      if ((en & (1 << INT_FRC1)) && isr[INT_FRC1] && sys.frc1Due && sys.frc1Due()) {
        sys.frc1Ack();
        enterIsr(INT_FRC1);
        return true;
      }
      if ((en & (1 << INT_FRC2)) && isr[INT_FRC2] && sys.frc2Due()) {
        sys.frc2Ack();
        enterIsr(INT_FRC2);
        return true;
      }
      if ((en & (1 << INT_UART)) && isr[INT_UART] && sys.rxfifoLen() > 0) {
        var ena = sys.getPeri(UART0 + 0x0c) >>> 0;     // UART_INT_ENA
        if (ena & 0x101) {                             // RXFIFO_FULL_INT_ENA(0) | RXFIFO_TOUT(8)
          enterIsr(INT_UART);
          return true;
        }
      }
      return false;
    }

    var T = {};

    // ---- printf-family (varargs) ----
    function format(fmt, next) {
      var out = '';
      for (var i = 0; i < fmt.length; i++) {
        var c = fmt[i]; if (c !== '%') { out += c; continue; }
        var spec = '%'; i++;
        while (i < fmt.length && '-+ #0'.indexOf(fmt[i]) >= 0) spec += fmt[i++];
        var width = ''; while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { width += fmt[i]; spec += fmt[i++]; }
        if (fmt[i] === '.') { spec += fmt[i++]; while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') spec += fmt[i++]; }
        while (i < fmt.length && 'lhzjtL'.indexOf(fmt[i]) >= 0) spec += fmt[i++];
        var cv = fmt[i], s = '';
        if (cv === '%') { out += '%'; continue; }
        else if (cv === 'd' || cv === 'i') s = (next() | 0).toString(10);
        else if (cv === 'u') s = (next() >>> 0).toString(10);
        else if (cv === 'x') s = (next() >>> 0).toString(16);
        else if (cv === 'X') s = (next() >>> 0).toString(16).toUpperCase();
        else if (cv === 'p') s = '0x' + (next() >>> 0).toString(16);
        else if (cv === 'c') s = String.fromCharCode(next() & 0xff);
        else if (cv === 's') { var p = next() >>> 0; s = p ? readStr(p) : '(null)'; }
        else s = spec;
        var w = parseInt(width || '0', 10);
        if (w > s.length) {
          if (spec.indexOf('-') >= 0) s = s + ' '.repeat(w - s.length);
          else s = ((spec.charAt(1) === '0' && cv !== 's' && cv !== 'c') ? '0' : ' ').repeat(w - s.length) + s;
        }
        out += s;
      }
      return out;
    }
    T.ets_printf = function () { var ai = 1; emit(format(readStr(A(0) >>> 0), function () { return argN(ai++); })); setRet(1); };
    // ets_vprintf(putc, fmt, va_list): on Xtensa a va_list is a three-word struct passed by value, so
    // it arrives in a4..a6 as __va_stk, __va_reg, __va_ndx. An argument comes from the register save
    // area while the index is within its 24 bytes, then from the stack area, whose first argument
    // sits at index 32 (__va_stk points 32 bytes below it).
    T.ets_vprintf = function () {
      var putc = A(0) >>> 0, fmtP = A(1) >>> 0, stk = A(2) >>> 0, reg = A(3) >>> 0, ndx = A(4) | 0;
      var out = format(readStr(fmtP), function () {
        var old = ndx; ndx += 4;
        if (old <= 24 && ndx > 24) ndx = 36;
        return sys.read32((((ndx <= 24 ? reg : stk) + ndx - 4)) >>> 0) | 0;
      });
      send(putc, out);
      setRet(out.length);
    };
    // Each character goes through the putc function the caller named, which on this firmware honours
    // esp.osdebug(); the ROM's own ets_write_char goes through whatever putc1 the guest installed.
    var putc1 = 0;
    var ETS_WRITE_CHAR = 0x40001da0;
    function send(putc, str) {
      var fn = putc === ETS_WRITE_CHAR ? putc1 : putc;
      if (fn < 0x40000000 || (fn >= 0x40000000 && fn < 0x40010000)) { emit(str); return; }
      for (var k = 0; k < str.length; k++) callGuest(fn, str.charCodeAt(k) & 0xff, 0);
    }
    T.ets_putc = function () { uartPut(A(0) & 0xff); setRet(A(0) & 0xff); };
    T.ets_write_char = function () { send(ETS_WRITE_CHAR, String.fromCharCode(A(0) & 0xff)); setRet(0); };
    T.ets_install_putc1 = function () { putc1 = A(0) >>> 0; setRet(0); };
    T.ets_install_putc2 = function () { setRet(0); };

    // ---- mem / str ----
    T.ets_memcpy = function () { var a = A(0) >>> 0, b = A(1) >>> 0, n = A(2) >>> 0; for (var k = 0; k < n; k++) sys.write8((a + k) >>> 0, sys.read8((b + k) >>> 0)); setRet(a); };
    T.ets_memmove = function () { var a = A(0) >>> 0, b = A(1) >>> 0, n = A(2) >>> 0; if (a < b || a >= b + n) { for (var k = 0; k < n; k++) sys.write8((a + k) >>> 0, sys.read8((b + k) >>> 0)); } else { for (var k2 = n - 1; k2 >= 0; k2--) sys.write8((a + k2) >>> 0, sys.read8((b + k2) >>> 0)); } setRet(a); };
    T.ets_memset = function () { var a = A(0) >>> 0, c = A(1) & 0xff, n = A(2) >>> 0; for (var k = 0; k < n; k++) sys.write8((a + k) >>> 0, c); setRet(a); };
    T.ets_bzero = function () { var a = A(0) >>> 0, n = A(1) >>> 0; for (var k = 0; k < n; k++) sys.write8((a + k) >>> 0, 0); setRet(a); };
    T.ets_memcmp = function () { var a = A(0) >>> 0, b = A(1) >>> 0, n = A(2) >>> 0; for (var k = 0; k < n; k++) { var x = sys.read8((a + k) >>> 0), y = sys.read8((b + k) >>> 0); if (x !== y) { setRet((x - y) | 0); return; } } setRet(0); };
    T.ets_strlen = function () { var p = A(0) >>> 0, n = 0; while (sys.read8((p + n) >>> 0)) n++; setRet(n); };
    T.ets_strcpy = function () { var d = A(0) >>> 0, s = A(1) >>> 0, b, d0 = d; do { b = sys.read8(s++); sys.write8(d++, b); } while (b); setRet(d0); };
    T.ets_strncpy = function () { var d = A(0) >>> 0, s = A(1) >>> 0, n = A(2) >>> 0, d0 = d, k = 0, b = 1; for (; k < n && b; k++) { b = sys.read8(s++); sys.write8(d++, b); } for (; k < n; k++) sys.write8(d++, 0); setRet(d0); };
    T.ets_strcmp = function () { var a = A(0) >>> 0, b = A(1) >>> 0, x, y; do { x = sys.read8(a++); y = sys.read8(b++); } while (x && x === y); setRet((x - y) | 0); };
    T.ets_strncmp = function () { var a = A(0) >>> 0, b = A(1) >>> 0, n = A(2) >>> 0, x = 0, y = 0; for (var k = 0; k < n; k++) { x = sys.read8(a++); y = sys.read8(b++); if (x !== y || !x) break; } setRet((x - y) | 0); };
    T.ets_strstr = function () { var h = readStr(A(0) >>> 0), n = readStr(A(1) >>> 0), i = h.indexOf(n); setRet(i < 0 ? 0 : ((A(0) >>> 0) + i) >>> 0); };

    // ---- libgcc 32-bit integer helpers (ROM) ----
    T.__udivsi3 = function () { var b = A(1) >>> 0; setRet(b === 0 ? -1 : ((A(0) >>> 0) / b) >>> 0); };
    T.__umodsi3 = function () { var b = A(1) >>> 0; setRet(b === 0 ? (A(0) >>> 0) : ((A(0) >>> 0) % b) >>> 0); };
    T.__divsi3 = function () { var b = A(1) | 0; setRet(b === 0 ? -1 : ((A(0) | 0) / b) | 0); };
    T.__modsi3 = function () { var b = A(1) | 0; setRet(b === 0 ? (A(0) | 0) : ((A(0) | 0) % b) | 0); };
    T.__mulsi3 = function () { setRet(Math.imul(A(0) | 0, A(1) | 0)); };

    // ---- libgcc soft-float + 64-bit helpers the ROM provides ----
    // CALL0 ABI: a float travels in one register, a double or long long in an even pair, low word
    // first. Single-precision +,-,*,/ done in a double and rounded back are correctly rounded
    // (53 >= 2*24+2), which is what the ROM's routines return.
    var fb = new Float32Array(1), fw = new Int32Array(fb.buffer), db = new Float64Array(1), dw = new Int32Array(db.buffer);
    function F(i) { fw[0] = A(i); return fb[0]; }
    function retF(v) { fb[0] = v; sys.setAr(2, fw[0]); }
    function D(i) { dw[0] = A(i); dw[1] = A(i + 1); return db[0]; }
    function retD(v) { db[0] = v; sys.setAr(2, dw[0]); sys.setAr(3, dw[1]); }
    function U64(i) { return (BigInt(A(i + 1) >>> 0) << 32n) | BigInt(A(i) >>> 0); }
    function S64(i) { return BigInt.asIntN(64, U64(i)); }
    function retB(v) { var u = BigInt.asUintN(64, v); sys.setAr(2, Number(u & 0xffffffffn) | 0); sys.setAr(3, Number(u >> 32n) | 0); }
    // Out-of-range conversions saturate as libgcc's do; NaN goes to the largest value.
    function toI32(v) { if (v !== v || v >= 2147483648) return 0x7fffffff; if (v <= -2147483649) return -0x80000000; return v | 0; }
    function toU32(v) { if (v !== v || v >= 4294967296) return -1; if (v <= -2147483649) return -0x80000000; return (v < 0 ? (v | 0) : (Math.trunc(v) >>> 0)) | 0; }
    T.__addsf3 = function () { retF(F(0) + F(1)); };
    T.__subsf3 = function () { retF(F(0) - F(1)); };
    T.__mulsf3 = function () { retF(F(0) * F(1)); };
    T.__floatsisf = function () { retF(A(0) | 0); };
    T.__floatunsisf = function () { retF(A(0) >>> 0); };
    T.__fixunssfsi = function () { setRet(toU32(F(0))); };
    T.__adddf3 = function () { retD(D(0) + D(2)); };
    T.__subdf3 = function () { retD(D(0) - D(2)); };
    T.__muldf3 = function () { retD(D(0) * D(2)); };
    T.__divdf3 = function () { retD(D(0) / D(2)); };
    T.__floatsidf = function () { retD(A(0) | 0); };
    T.__floatunsidf = function () { retD(A(0) >>> 0); };
    T.__fixdfsi = function () { setRet(toI32(D(0))); };
    T.__fixunsdfsi = function () { setRet(toU32(D(0))); };
    T.__truncdfsf2 = function () { retF(D(0)); };
    T.__extendsfdf2 = function () { retD(F(0)); };
    T.__muldi3 = function () { retB(U64(0) * U64(2)); };
    T.__umulsidi3 = function () { retB(BigInt(A(0) >>> 0) * BigInt(A(1) >>> 0)); };
    T.__udivdi3 = function () { var b = U64(2); retB(b === 0n ? 0n : U64(0) / b); };
    T.__umoddi3 = function () { var b = U64(2); retB(b === 0n ? 0n : U64(0) % b); };
    T.__divdi3 = function () { var b = S64(2); retB(b === 0n ? 0n : S64(0) / b); };

    // ---- exception-handler registration (xtos): store & report previous (0) ----
    T._xtos_set_exception_handler = function () { setRet(0); };
    T._xtos_set_interrupt_handler = function () { setRet(0); };
    T._xtos_set_interrupt_handler_arg = function () { setRet(0); };
    T._xtos_ints_on = function () { setRet(0); };
    T._xtos_ints_off = function () { setRet(0); };

    // ---- interrupts (ets) ----
    T.ets_isr_attach = function () { isr[A(0) >>> 0] = { fn: A(1) >>> 0, arg: A(2) >>> 0 }; setRet(0); };
    T.ets_isr_mask = function () { sys.srWrite(SR_INTENABLE, (sys.srRead(SR_INTENABLE) & ~A(0)) >>> 0); setRet(0); };
    T.ets_isr_unmask = function () { sys.srWrite(SR_INTENABLE, (sys.srRead(SR_INTENABLE) | A(0)) >>> 0); setRet(0); };
    // ets_intr_lock / unlock are RSIL 3 / RSIL 0, and the ROM keeps no nesting count.
    T.ets_intr_lock = function () { sys.sr.ps = ((sys.sr.ps & ~0xf) | 3) >>> 0; setRet(0); };
    T.ets_intr_unlock = function () { sys.sr.ps = (sys.sr.ps & ~0xf) >>> 0; setRet(0); };

    // ---- os_task scheduler ----
    T.ets_task = function () { tasks[A(1) >>> 0] = { fn: A(0) >>> 0 }; setRet(0); };   // (fn, prio, queue, qlen)
    T.ets_post = function () { pend.push({ prio: A(0) >>> 0, sig: A(1) >>> 0, par: A(2) >>> 0 }); setRet(0); return false; };
    // ets_run: the NONOS main loop.  Never returns to its caller.  Each entry:
    // take a pending interrupt, then dispatch one pending os_task event
    // (jumping into the task with ra pointing back here); else idle (re-enter).
    T.ets_run = function () {
      sys.setPc(ETS_RUN);
      if (pumpIrq()) return true;
      if (pend.length) {
        var ev = null, bestP = -1;
        for (var i = 0; i < pend.length; i++) { if (pend[i].prio > bestP) { bestP = pend[i].prio; } }
        for (var j = 0; j < pend.length; j++) { if (pend[j].prio === bestP) { ev = pend.splice(j, 1)[0]; break; } }
        var task = tasks[ev.prio];
        if (task) {
          sys.write32(EVT_SCRATCH, ev.sig >>> 0);
          sys.write32((EVT_SCRATCH + 4) >>> 0, ev.par >>> 0);
          sys.setAr(2, EVT_SCRATCH);       // ETSEvent *e
          sys.setAr(0, ETS_RUN);           // return re-enters ets_run
          sys.setPc(task.fn >>> 0);
          return true;                     // jumped (core must NOT overwrite pc)
        }
      }
      sys.setPc(ETS_RUN);                   // idle: re-enter next step
      return true;
    };
    T.ets_set_idle_cb = function () { setRet(0); };

    // ---- ETSTimer software timers.  ETSTimer { next(+0), expire(+4), period(+8),
    //      func(+0xC), arg(+0x10) }.  setfn must write func/arg so the SDK never
    //      sees a null callback ("cb is null").  arm records the period; the
    //      callbacks do not fire from here. This image never reaches these ROM entries:
    //      the SDK's own timer list runs on FRC2 (see pumpIrq).
    var timers = [];   // list of armed ETSTimer struct addrs
    T.ets_timer_setfn = function () { var t = A(0) >>> 0; sys.write32((t + 0xC) >>> 0, A(1) >>> 0); sys.write32((t + 0x10) >>> 0, A(2) >>> 0); setRet(0); };
    T.ets_timer_arm = function () { var t = A(0) >>> 0; sys.write32((t + 0x8) >>> 0, A(1) >>> 0); if (timers.indexOf(t) < 0) timers.push(t); setRet(0); };
    T.ets_timer_arm_new = function () { var t = A(0) >>> 0; sys.write32((t + 0x8) >>> 0, A(1) >>> 0); if (timers.indexOf(t) < 0) timers.push(t); setRet(0); };
    T.ets_timer_disarm = function () { var t = A(0) >>> 0, k = timers.indexOf(t); if (k >= 0) timers.splice(k, 1); setRet(0); };
    T.ets_timer_init = function () { setRet(0); };

    // ---- delay / clock ----
    T.ets_delay_us = function () { if (sys.addUs) sys.addUs(A(0) >>> 0); setRet(0); };
    T.ets_get_cpu_frequency = function () { setRet(cpuMhz); };
    T.ets_update_cpu_frequency = function () { cpuMhz = A(0) >>> 0; sys.setCpuMhz(cpuMhz); setRet(0); };
    T.xthal_get_ccount = function () { setRet(sys.getCycles() >>> 0); };
    T.xthal_set_ccompare = function () { setRet(0); };

    // ---- watchdog (fed / disabled) ----
    ['ets_wdt_disable', 'ets_wdt_enable', 'ets_wdt_init', 'ets_wdt_get_mode', 'ets_wdt_restore']
      .forEach(function (n) { T[n] = function () { setRet(0); }; });

    // ---- cache: flash is direct-mapped -> no-ops ----
    T.Cache_Read_Enable = function () { setRet(0); };
    T.Cache_Read_Disable = function () { setRet(0); };

    // ---- SPI flash ----
    T.SPIRead = function () {
      var addr = A(0) >>> 0, dst = A(1) >>> 0, size = A(2) >>> 0, fl = sys.mem.flash;
      for (var k = 0; k < size; k++) sys.write8((dst + k) >>> 0, fl[(addr + k) & (fl.length - 1)] | 0);
      setRet(0);
    };
    T.SPIWrite = function () {      // NOR flash: programming can only clear bits
      var addr = A(0) >>> 0, src = A(1) >>> 0, size = A(2) >>> 0, fl = sys.mem.flash;
      for (var k = 0; k < size; k++) fl[(addr + k) & (fl.length - 1)] &= sys.read8((src + k) >>> 0);
      setRet(0);
    };
    T.SPIEraseSector = function () { var sec = A(0) >>> 0, fl = sys.mem.flash, base = (sec * 4096) & (fl.length - 1); for (var k = 0; k < 4096; k++) fl[base + k] = 0xff; setRet(0); };
    T.SPIEraseBlock = function () { var blk = A(0) >>> 0, fl = sys.mem.flash, base = (blk * 65536) & (fl.length - 1); for (var k = 0; k < 65536; k++) fl[base + k] = 0xff; setRet(0); };
    T.Wait_SPI_Idle = function () { setRet(0); };
    T.SPI_read_status = function () { setRet(0); };
    T.SPI_write_status = function () { setRet(0); };
    T.SPIReadModeCnfig = function () { setRet(0); };
    T.SPIParamCfg = function () { setRet(0); };
    T.spi_flash_get_id = function () { setRet(0x001640ef); };   // generic 4Mbit-ID-ish

    // ---- analog I2C (BBPLL/RTC): report "locked"/all-ones so PLL polls pass ----
    T.rom_i2c_readReg = function () { setRet(0xff); };
    T.rom_i2c_readReg_Mask = function () { setRet(0xff); };
    T.rom_i2c_writeReg = function () { setRet(0); };
    T.rom_i2c_writeReg_Mask = function () { setRet(0); };

    // ---- MD5 in ROM (esp.check_fw hashes the firmware with it). The context lives in guest memory,
    //      as in the ROM: { u32 buf[4]; u32 bits[2]; u8 in[64]; } ----
    var MD5_K = [], MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (var mi = 0; mi < 64; mi++) MD5_K[mi] = Math.floor(Math.abs(Math.sin(mi + 1)) * 4294967296) >>> 0;
    function md5Block(ctx, blk) {
      var a0 = sys.read32(ctx) | 0, b0 = sys.read32(ctx + 4) | 0, c0 = sys.read32(ctx + 8) | 0, d0 = sys.read32(ctx + 12) | 0;
      var a = a0, b = b0, c = c0, d = d0;
      for (var i = 0; i < 64; i++) {
        var f, g, round = i >> 4;
        if (round === 0) { f = (b & c) | (~b & d); g = i; }
        else if (round === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (round === 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        var x = (a + f + MD5_K[i] + (blk[g] | 0)) | 0, s = MD5_S[(round << 2) | (i & 3)];
        a = d; d = c; c = b;
        b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      }
      sys.write32(ctx, (a0 + a) >>> 0); sys.write32(ctx + 4, (b0 + b) >>> 0);
      sys.write32(ctx + 8, (c0 + c) >>> 0); sys.write32(ctx + 12, (d0 + d) >>> 0);
    }
    function md5BlockFrom(ctx, get) {   // one 64-byte block, byte i = get(i)
      var blk = [];
      for (var w = 0; w < 16; w++) blk[w] = (get(w * 4) | (get(w * 4 + 1) << 8) | (get(w * 4 + 2) << 16) | (get(w * 4 + 3) << 24)) | 0;
      md5Block(ctx, blk);
    }
    function md5Absorb(ctx, p, n) {
      var lo = sys.read32(ctx + 16) >>> 0, have = (lo >>> 3) & 63, IN = (ctx + 24) >>> 0;
      var nlo = (lo + n * 8) >>> 0;
      sys.write32(ctx + 16, nlo);
      sys.write32(ctx + 20, (sys.read32(ctx + 20) + Math.floor((lo + n * 8) / 4294967296)) >>> 0);
      var i = 0;
      while (n - i >= 64 - have) {
        if (have === 0) { var base = (p + i) >>> 0; md5BlockFrom(ctx, function (k) { return sys.read8(base + k); }); i += 64; continue; }
        for (var k = have; k < 64; k++) sys.write8(IN + k, sys.read8((p + i++) >>> 0));
        md5BlockFrom(ctx, function (k2) { return sys.read8(IN + k2); });
        have = 0;
      }
      while (i < n) sys.write8(IN + have++, sys.read8((p + i++) >>> 0));
    }
    T.MD5Init = function () {
      var ctx = A(0) >>> 0;
      sys.write32(ctx, 0x67452301); sys.write32(ctx + 4, 0xefcdab89); sys.write32(ctx + 8, 0x98badcfe); sys.write32(ctx + 12, 0x10325476);
      sys.write32(ctx + 16, 0); sys.write32(ctx + 20, 0);
      setRet(0);
    };
    T.MD5Update = function () { md5Absorb(A(0) >>> 0, A(1) >>> 0, A(2) >>> 0); setRet(0); };
    T.MD5Final = function () {          // (digest, ctx)
      var out = A(0) >>> 0, ctx = A(1) >>> 0, lo = sys.read32(ctx + 16) >>> 0, hi = sys.read32(ctx + 20) >>> 0;
      var have = (lo >>> 3) & 63, IN = (ctx + 24) >>> 0;
      sys.write8(IN + have++, 0x80);
      if (have > 56) { while (have < 64) sys.write8(IN + have++, 0); md5BlockFrom(ctx, function (k) { return sys.read8(IN + k); }); have = 0; }
      while (have < 56) sys.write8(IN + have++, 0);
      sys.write32(IN + 56, lo); sys.write32(IN + 60, hi);
      md5BlockFrom(ctx, function (k) { return sys.read8(IN + k); });
      for (var i = 0; i < 16; i++) sys.write8(out + i, sys.read8(ctx + i));
      setRet(0);
    };

    // ---- GPIO (the same registers the machine exposes directly) ----
    var GPIO = 0x60000300;
    T.gpio_output_set = function () {       // (set, clear, enable, disable)
      sys.write32(GPIO + 0x04, A(0) >>> 0); sys.write32(GPIO + 0x08, A(1) >>> 0);
      sys.write32(GPIO + 0x10, A(2) >>> 0); sys.write32(GPIO + 0x14, A(3) >>> 0);
      setRet(0);
    };
    T.gpio_input_get = function () { setRet(sys.getPeri(GPIO + 0x18)); };

    // ---- misc reset/efuse ROM helpers occasionally referenced ----
    T.rtc_get_reset_reason = function () { setRet(resetReason); };
    T.ets_str2macaddr = function () { setRet(0); };
    T.roundup2 = function () { var y = A(1) | 0; setRet((A(0) + y - 1) & -y); };

    // A restart from inside: the SDK's system_restart ends by jumping to the ROM's reset vector.
    function chipReset() { resetReason = 2; if (env.onChipReset) env.onChipReset(); return true; }
    T._ResetVector = chipReset;
    T._ResetHandler = chipReset;
    T.software_reset = chipReset;

    // What the ROM's startup leaves behind for the application. `flashchip` (0x3FFFC714) holds a pointer
    // to the SpiFlashChip struct right after it: { deviceId, chip_size, block_size, sector_size,
    // page_size, status_mask }. The SDK's startup sets chip_size from the image header, then divides it
    // by sector_size to find its parameter sectors at the top of the chip. esp.flash_size() reads it.
    var FLASHCHIP = 0x3FFFC714;
    T.__installRomData = function () {
      sys.write32(FLASHCHIP, (FLASHCHIP + 4) >>> 0);
      sys.write32((FLASHCHIP + 4) >>> 0, sys.map.FLASH_JEDEC_ID);
      sys.write32((FLASHCHIP + 8) >>> 0, sys.map.FLASH_CHIP_SIZE);
      sys.write32((FLASHCHIP + 12) >>> 0, 0x10000);
      sys.write32((FLASHCHIP + 16) >>> 0, 0x1000);
      sys.write32((FLASHCHIP + 20) >>> 0, 0x100);
      sys.write32((FLASHCHIP + 24) >>> 0, 0xffff);
    };
    // Chip reset: everything the ROM held in RAM starts again. powerOn=true is the Reboot button.
    T.__reset = function (powerOn) {
      for (var k in isr) delete isr[k];
      for (var k2 in tasks) delete tasks[k2];
      pend.length = 0; timers.length = 0;
      irqCtx = null; cpuMhz = 80; putc1 = 0;
      if (powerOn) resetReason = 1;
    };

    // expose scheduler/interrupt hooks the boot-runtime needs
    T.__pumpIrq = pumpIrq;
    T.__irqReturn = irqReturn;
    T.__IRQ_RETURN = IRQ_RETURN;
    T.__rxfifoLen = function () { return sys.rxfifoLen(); };
    T.__pend = pend;
    T.__tasks = tasks;
    T.__isr = isr;
    return T;
  }

  var api = { makeRomHle: makeRomHle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ESP8266_ROMHLE = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
