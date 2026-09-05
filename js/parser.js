export class MetaShuntParser {
  constructor(onMeasurement, { logStatsEveryMs = 3000, onStats = null } = {}) {
    this.onMeasurement = onMeasurement;
    this.onStats = onStats;
    this.logStatsEveryMs = logStatsEveryMs;

    // Cursor-based buffer: we avoid re-slicing the whole buffer on every
    // step. `pos` marks the next unconsumed byte. Leftovers are compacted
    // only when a new chunk arrives.
    this.buffer = new Uint8Array(0);
    this.pos = 0;

    this.step = 0;
    this.count = 0;
    this.chk = 0;
    this.payload = new Uint8Array(8);

    this.t0 = null;

    // Diagnostics
    this.stats = { valid: 0, cksumFail: 0, resyncAA: 0, monoDrop: 0, gapDrop: 0, curDrop: 0, nanDrop: 0 };
    this.lastStatsAt = 0;
    // Raw tick-delta histogram for diagnosing periodic firmware hiccups.
    this.tickDeltas = [];
    this.prevRawTicks = null;
    this.warnCount = 0;
    this.warnLastAt = 0;
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.pos = 0;
    this.step = 0;
    this.count = 0;
    this.chk = 0;
    this.payload = new Uint8Array(8);
    this.t0 = null;
    this.stats = { valid: 0, cksumFail: 0, resyncAA: 0, monoDrop: 0, gapDrop: 0, curDrop: 0, nanDrop: 0 };
    this.lastStatsAt = 0;
    this.tickDeltas = [];
    this.prevRawTicks = null;
    this.warnCount = 0;
    this.warnLastAt = 0;
  }

  push(chunk) {
    // Byte-by-byte streaming state machine mirroring the Python parser's
    // get_packet(): one byte at a time, no cursor scan, no slice/merge rewinds.
    // Any non-0xAA byte while hunting a header is skipped (incl. the 0x00
    // separator bytes the device emits between frames).
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      const b = chunk[i++];

      if (this.step === 0) {
        if (b === 0xAA) {
          this.step = 1;
          this.count = 0;
          this.chk = 0;
        } else {
          this.stats.resyncAA++;
          this._logDebug(`[parser] skipped 0x${b.toString(16)} while hunting header`);
        }
        continue;
      }

      if (this.step === 1) {
        this.payload[this.count] = b;
        this.count++;
        this.chk = (this.chk + b) & 0xff;
        if (this.count === 8) this.step = 2;
        continue;
      }

      if (this.step === 2) {
        if (b === this.chk) {
          this._emitPacket(this.payload.slice(0, 8));
        } else {
          this.stats.cksumFail++;
          this._logDebug(
            `[parser] Checksum fail: expected ${this.chk}, got ${b}. ` +
            `Payload bytes [${Array.from(this.payload).map(x => x.toString(16).padStart(2, '0')).join(' ')}]`
          );
        }
        this.step = 0;  // fresh state: hunt for the next 0xAA
      }
    }
  }

  _maybeLogStats(now) {
    if (now - this.lastStatsAt < this.logStatsEveryMs) return;
    this.lastStatsAt = now;

    // Summarize tick deltas: [<1ms, 1-10ms, 10-100ms, >100ms] in seconds
    let d01 = 0, d10 = 0, d100 = 0, dBig = 0;
    for (const d of this.tickDeltas) {
      const s = d / 4 / 1e6;
      if (s < 0.001) d01++; else if (s < 0.01) d10++; else if (s < 0.1) d100++; else dBig++;
    }
    this.tickDeltas.length = 0;

    const s = this.stats;
    console.log(
      `[parser-stats] valid=${s.valid} cksumFail=${s.cksumFail} resyncAA=${s.resyncAA} ` +
      `monoDrop=${s.monoDrop} gapDrop=${s.gapDrop} curDrop=${s.curDrop} nanDrop=${s.nanDrop} ` +
      `deltas(<1ms=${d01},1-10ms=${d10},10-100ms=${d100},>100ms=${dBig})`
    );
    if (this.onStats) this.onStats({ ...s });
  }

  // Throttled debug log: prints a count + first message each stats window to
// avoid flooding the console (a flood can itself stall the UI).
  _logDebug(msg) {
    this.warnCount++;
    const now = performance.now();
    if (this._debugFirstMsg === undefined) this._debugFirstMsg = msg;
    if (now - this.warnLastAt > 3000) {
      console.warn(`[parser] (${this.warnCount} events) e.g. ${this._debugFirstMsg}`);
      this.warnCount = 0;
      this._debugFirstMsg = undefined;
      this.warnLastAt = now;
    }
  }

  _emitPacket(payload) {
    const dv = new DataView(payload.buffer);
    const t_ticks = dv.getUint32(0, true);
    const current_mA = dv.getFloat32(4, true);

    // Record the raw tick delta regardless of validation outcome.
    if (this.prevRawTicks !== null) {
      const dt = t_ticks - this.prevRawTicks;
      // Handle 32-bit wraparound (delta as signed).
      const delta = (dt << 0) < 0 ? dt + 4294967296 : dt;
      this.tickDeltas.push(delta);
    }
    this.prevRawTicks = t_ticks;

    if (this.t0 === null) {
      this.t0 = t_ticks;
      this.lastValidSec = -1; // Initialize tracking for monotonic time
    }

    const relSec = ((t_ticks - this.t0) / 4) / 1e6;
    const current_uA = current_mA * 1000.0;

    // --- VALIDATION GATE ---
    // 0. Non-finite guard: a checksum-passing but mis-aligned garbage frame can
    //    yield NaN/Infinity time or current. NaN would otherwise slip past the
    //    comparison gates below and create a visible hole in the plot.
    if (!Number.isFinite(current_uA) || !Number.isFinite(relSec)) {
      this.stats.nanDrop++;
      console.warn(`[parser] Drop (non-finite): ticks=${t_ticks}, current_ma=${current_mA} (unpacked ${current_uA} µA)`);
      return;
    }

    // 1. Enforce monotonic time (drop backward jumps)
    if (relSec <= this.lastValidSec) {
      this.stats.monoDrop++;
      console.warn(`[parser] Drop (monotonic): relSec=${relSec.toFixed(6)} <= last=${this.lastValidSec.toFixed(6)}, ticks=${t_ticks}, current=${current_uA.toFixed(1)} µA`);
      return;
    }

    // 2. Time change between datapoint should be small. Generous threshold (2s) so
    // a momentary processing/transport stall (e.g. >100ms gap) does NOT cause a
    // cascade where every following frame is rejected: lastValidSec only updates
    // on acceptance, so a single drop at a small threshold permanently wedges
    // the parser. 2s still rejects clearly malformed/fabricated time jumps.
    if ((relSec - this.lastValidSec) > 2.0 && this.lastValidSec > 0.0) {
      this.stats.gapDrop++;
      const dtTicks = this.prevRawTicks !== null ? (t_ticks - this.prevRawTicks) : 0;
      const dtTicksWrapped = (dtTicks << 0) < 0 ? dtTicks + 4294967296 : dtTicks;
      console.warn(
        `[parser] Drop (gap): dt=${(relSec - this.lastValidSec).toFixed(3)} s, ` +
        `raw tick delta=${dtTicksWrapped} (→ inferred ${((dtTicksWrapped / 4) / 1e6).toFixed(3)} s @4/MHz, ${((dtTicksWrapped / 4) / 1e6).toFixed(3)} s) ` +
        `at t=${relSec.toFixed(3)} s, current=${current_uA.toFixed(1)} µA`
      );
      return;
    }

    // 3. Physical Limits (MetaShunt range: slightly below zero to slightly >2.2A)
    if (current_uA > 2200000 || current_uA < -5000) {
      this.stats.curDrop++;
      console.warn(`[parser] Drop (current range): ${current_uA.toFixed(1)} µA at t=${relSec.toFixed(3)} s`);
      return;
    }

    this.stats.valid++;
    this.lastValidSec = relSec;

    this._maybeLogStats(performance.now());

    // Valid point, send it out
    this.onMeasurement({ t: relSec, current_uA });
  }
}