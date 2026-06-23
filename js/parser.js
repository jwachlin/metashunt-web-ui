export class MetaShuntParser {
  constructor(onMeasurement) {
    this.onMeasurement = onMeasurement;

    this.buffer = new Uint8Array(0);
    this.step = 0;
    this.count = 0;
    this.chk = 0;
    this.payload = new Uint8Array(0);

    this.t0 = null;
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.step = 0;
    this.count = 0;
    this.chk = 0;
    this.payload = new Uint8Array(0);
    this.t0 = null;
  }

  push(chunk) {
    // Append incoming bytes
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    while (true) {
      // Step 0: find frame header
      if (this.step === 0) {
        const idx = this.buffer.indexOf(0xAA);
        if (idx === -1) {
          this.buffer = new Uint8Array(0);
          return;
        }
        this.buffer = this.buffer.slice(idx + 1);
        this.step = 1;
        this.count = 0;
        this.chk = 0;
        this.payload = new Uint8Array(0);
      }

      // Step 1: read 8-byte payload
      if (this.step === 1) {
        if (this.buffer.length < (8 - this.count)) return;

        const need = 8 - this.count;
        const bytes = this.buffer.slice(0, need);
        this.buffer = this.buffer.slice(need);

        const tmp = new Uint8Array(this.payload.length + bytes.length);
        tmp.set(this.payload);
        tmp.set(bytes, this.payload.length);
        this.payload = tmp;

        for (let b of bytes) this.chk = (this.chk + b) & 0xff;
        this.count += bytes.length;

        if (this.count === 8) this.step = 2;
      }

      // Step 2: checksum
      if (this.step === 2) {
        if (this.buffer.length < 1) return;

        const c = this.buffer[0];
        this.buffer = this.buffer.slice(1);

        if (c === this.chk) {
          this._emitPacket(this.payload);
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
    if (relSec <= this.lastValidSec)
    {
      console.error('Time not increasing');
      return;
    }

    // 2. Time change between datapoint should be small
    if((relSec - this.lastValidSec) > 0.1 && this.lastValidSec > 0.0)
    {
      console.error('Time increase too large');
      return;
    }

    // 3. Physical Limits (MetaShunt range: slightly below zero to slightly >2.2A)
    if (current_uA > 2200000 || current_uA < -5000)
    {
      console.error('Measurements not reasonable');
      return;
    }

    this.lastValidSec = relSec;
    
    // Valid point, send it out
    this.onMeasurement({ t: relSec, current_uA });
  }
}
