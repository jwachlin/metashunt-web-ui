export class MetaShuntParser {
  constructor(onMeasurement) {
    this.onMeasurement = onMeasurement;

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
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.pos = 0;
    this.step = 0;
    this.count = 0;
    this.chk = 0;
    this.payload = new Uint8Array(8);
    this.t0 = null;
  }

  push(chunk) {
    // Keep only unconsumed bytes, then append the new chunk.
    if (this.pos >= this.buffer.length) {
      this.buffer = chunk;
    } else {
      const pending = this.buffer.length - this.pos;
      const merged = new Uint8Array(pending + chunk.length);
      merged.set(this.buffer.subarray(this.pos));
      merged.set(chunk, pending);
      this.buffer = merged;
    }
    this.pos = 0;

    while (true) {
      // Step 0: find frame header
      if (this.step === 0) {
        const idx = this.buffer.indexOf(0xAA, this.pos);
        if (idx === -1) {
          this.buffer = new Uint8Array(0);
          this.pos = 0;
          return;
        }
        this.pos = idx + 1;
        this.step = 1;
        this.count = 0;
        this.chk = 0;
      }

      // Step 1: read the 8-byte payload
      if (this.step === 1) {
        const avail = this.buffer.length - this.pos;
        const need = 8 - this.count;
        if (avail < need) {
          // Not enough bytes yet; stash tail for next chunk.
          this.buffer = this.buffer.slice(this.pos);
          this.pos = 0;
          return;
        }
        for (let i = 0; i < need; i++) {
          const b = this.buffer[this.pos + i];
          this.payload[this.count + i] = b;
          this.chk = (this.chk + b) & 0xff;
        }
        this.count += need;
        this.pos += need;
        this.step = 2;
      }

      // Step 2: checksum
      if (this.step === 2) {
        if (this.buffer.length - this.pos < 1) {
          this.buffer = this.buffer.slice(this.pos);
          this.pos = 0;
          return;
        }

        const c = this.buffer[this.pos];
        this.pos += 1; // consume the checksum byte regardless

        if (c === this.chk) {
          this._emitPacket(this.payload.slice(0, 8));
        }

        this.step = 0;
      }
    }
  }

  _emitPacket(payload) {
    const dv = new DataView(payload.buffer);
    const t_ticks = dv.getUint32(0, true);
    const current_mA = dv.getFloat32(4, true);

    if (this.t0 === null) {
      this.t0 = t_ticks;
      this.lastValidSec = -1; // Initialize tracking for monotonic time
    }

    const relSec = ((t_ticks - this.t0) / 4) / 1e6;
    const current_uA = current_mA * 1000.0;

    // --- VALIDATION GATE ---
    // 1. Enforce monotonic time (drop backward jumps)
    if (relSec <= this.lastValidSec) {
      console.error('Time not increasing');
      return;
    }

    // 2. Time change between datapoint should be small
    if ((relSec - this.lastValidSec) > 0.1 && this.lastValidSec > 0.0) {
      console.error('Time increase too large');
      return;
    }

    // 3. Physical Limits (MetaShunt range: slightly below zero to slightly >2.2A)
    if (current_uA > 2200000 || current_uA < -5000) {
      console.error('Measurements not reasonable');
      return;
    }

    this.lastValidSec = relSec;

    // Valid point, send it out
    this.onMeasurement({ t: relSec, current_uA });
  }
}