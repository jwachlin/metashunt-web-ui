// Compact growable sample store backed by Float64Array. Holds (t, current_uA,
// charge) triples at ~24 bytes/sample, doubling capacity as needed.
export class SampleStore {
  constructor(initialCapacity = 32768) {
    this.n = 0;
    this.cap = initialCapacity;
    this.t = new Float64Array(this.cap);
    this.i = new Float64Array(this.cap);
    this.q = new Float64Array(this.cap);
  }

  get length() { return this.n; }

  clear() { this.n = 0; }

  push(t, i, q) {
    if (this.n >= this.cap) this._grow();
    this.t[this.n] = t;
    this.i[this.n] = i;
    this.q[this.n] = q;
    this.n++;
  }

  _grow() {
    this.cap *= 2;
    const nt = new Float64Array(this.cap); nt.set(this.t);
    const ni = new Float64Array(this.cap); ni.set(this.i);
    const nq = new Float64Array(this.cap); nq.set(this.q);
    this.t = nt; this.i = ni; this.q = nq;
  }

  // Estimated bytes for the DATA RECORDED so far (n samples × 3 arrays × 8B),
  // not the preallocated capacity.
  memBytes() { return this.n * 3 * 8; }

  // Keep every k-th sample (subsample the store in place) to bound memory.
  subsample(step) {
    if (step <= 1) return;
    let dst = 0;
    for (let src = 0; src < this.n; src += step) {
      this.t[dst] = this.t[src];
      this.i[dst] = this.i[src];
      this.q[dst] = this.q[src];
      dst++;
    }
    this.n = dst;
  }
}

// Streaming decimator: emits a compressed point whenever the incoming sample
// changes by more than `intensity` (fraction) RELATIVE to the last decimated
// value, or after `maxSpan` raw samples with no such change (stable data).
// The emitted current is the time-weighted average over the interval so the
// area under the current curve is preserved; charge is kept from the raw
// cumulative charge so the integral stays exact.
export class Decimator {
  constructor(intensity = 0.01, maxSpan = 1000) {
    this.intensity = intensity;
    this.maxSpan = maxSpan;
    this.reset();
  }

  reset() {
    this.lastEmitI = null;
    this.sumIT = 0;    // Σ I·dt (trapezoid), µA·s
    this.sumDt = 0;
    this.count = 0;
    this.prevRawT = null;
    this.prevRawI = null;
  }

  // Feed one raw sample (t, i, q). Returns a decimated point object or null.
  step(t, i, q) {
    // First sample always kept.
    if (this.lastEmitI === null) {
      this.lastEmitI = i;
      this.prevRawT = t;
      this.prevRawI = i;
      this.sumIT = 0; this.sumDt = 0; this.count = 0;
      return { t, i, q };
    }

    if (t > this.prevRawT && this.prevRawT !== null) {
      const segDt = t - this.prevRawT;
      this.sumIT += (i + this.prevRawI) * segDt / 2;
      this.sumDt += segDt;
    }

    this.count++;
    // Threshold is relative to the last EMITTED (averaged) decimated value,
    // floored at 0.05 µA so noise at very low current doesn't over-expand the
    // dataset.
    const threshold = Math.max(this.intensity * Math.abs(this.lastEmitI), 0.05);
    const changed = Math.abs(i - this.lastEmitI) > threshold;
    const emit = changed || this.count >= this.maxSpan;

    this.prevRawT = t;
    this.prevRawI = i;

    if (!emit) return null;

    const avgI = this.sumDt > 0 ? this.sumIT / this.sumDt : i;
    this.lastEmitI = avgI;
    this.sumIT = 0; this.sumDt = 0; this.count = 0;
    return { t, i: avgI, q };
  }
}