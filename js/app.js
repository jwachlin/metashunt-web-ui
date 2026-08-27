import { MetaShuntSerial } from './webSerial.js';

/* -------------------- DOM -------------------- */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const deviceInfoEl = document.getElementById('deviceInfo');

const loadCsvBtn = document.getElementById('loadCsvBtn');
const clearCsvBtn = document.getElementById('clearCsvBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportImgsBtn = document.getElementById('exportImgsBtn');
const plotMemoryBtn = document.getElementById('plotMemoryBtn');
const csvOffsetInput   = document.getElementById('csvOffset');
const csvOffsetControl = document.getElementById('csvOffsetControl');
const csvOffsetUp      = document.getElementById('csvOffsetUp');
const csvOffsetDown    = document.getElementById('csvOffsetDown');

/* -------------------- DEVICE -------------------- */

const device = new MetaShuntSerial();

device.onData(handleMeasurement);
device.onStatus(setStatus);

/* -------------------- DATA -------------------- */

let curRows = []; // { t, current_uA, q } - full retained history (memory-bounded)

// Dedicated visual buffers for the sliding window
let liveX = [], liveY = [];
let liveQX = [], liveQY = [];

// CSV display data (decimated so plotting/shifting stays cheap)
let csvX = [], csvY = [];
let csvQX = [], csvQY = [];
let csvLoaded = false;
let csvTimeOffset = 0;

const FLUSH_MS = 50;
const WINDOW_S = 10;         // sliding window length (seconds)
const MAX_MEMORY = 2000000;  // cap for retained history records
const PLOT_MAX = 60000;      // max points rendered per plot per trace

let needsUpdate = false;
let isViewingMemory = false; // Lock to prevent live data from overwriting memory plots
let tick = 0;

/* -------------------- ANALYSIS CONFIG/STATE -------------------- */

const cfg = { thresholdUA: 0, batteryMah: 0 };
let regionActive = false;
let regionBounds = [null, null]; // [xLo, xHi] seconds

// Live stats DOM
const stAvg   = document.getElementById('stAvg');
const stMin   = document.getElementById('stMin');
const stMax   = document.getElementById('stMax');
const stSd    = document.getElementById('stSd');
const stCharge= document.getElementById('stCharge');
const stBatt  = document.getElementById('stBatt');
const stViol  = document.getElementById('stViol');
const regionStatsEl = document.getElementById('regionStats');

// Plotly theme colors, derived from the CSS theme so charts follow toggles.
function theme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    dark,
    paper: dark ? '#171a21' : '#ffffff',
    plot: dark ? '#171a21' : '#ffffff',
    grid: dark ? '#2a2e38' : '#eef1f6',
    text: dark ? '#e5e7eb' : '#222',
    muted: dark ? '#9ca3af' : '#6b7280'
  };
}

function themedLayout(base) {
  const t = theme();
  return {
    ...base,
    paper_bgcolor: t.paper,
    plot_bgcolor: t.plot,
    font: { color: t.text },
    xaxis: { ...base.xaxis, gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid, tickfont: { color: t.muted } },
    yaxis: { ...base.yaxis, gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid, tickfont: { color: t.muted } }
  };
}

// Manual labels: point annotations + named regions
let notes = [];            // { id, t, y, text, color }
let regionLabel = '';      // shown on the region, if set
let lastClickT = null;     // cursor x from last click on the current plot

/* -------------------- HELPERS -------------------- */

// Min/max decimation: keeps peaks so waveforms stay accurate at low point counts.
function decimate(x, y, maxN) {
  const n = x.length;
  if (n <= maxN) return { x, y };
  const bucket = Math.max(1, Math.ceil(n / maxN));
  const rx = [], ry = [];
  for (let i = 0; i < n; i += bucket) {
    const end = Math.min(i + bucket, n);
    let mnI = i, mxI = i;
    for (let j = i + 1; j < end; j++) {
      if (y[j] < y[mnI]) mnI = j;
      if (y[j] > y[mxI]) mxI = j;
    }
    const keep = new Set([i, mnI, mxI]);
    for (const k of [...keep].sort((a, b) => a - b)) {
      rx.push(x[k]);
      ry.push(y[k]);
    }
  }
  return { x: rx, y: ry };
}

// Keep retained history bounded by decimating when it exceeds MAX_MEMORY.
function capMemory() {
  if (curRows.length <= MAX_MEMORY) return;
  const target = MAX_MEMORY / 2;
  const step = Math.ceil(curRows.length / target);
  if (step < 2) return;
  const kept = new Array(Math.ceil(curRows.length / step));
  let k = 0;
  for (let i = 0; i < curRows.length; i += step) kept[k++] = curRows[i];
  curRows = kept;
}

function shiftedCsvX()  { return csvX.map(x => x + csvTimeOffset); }
function shiftedCsvQX() { return csvQX.map(x => x + csvTimeOffset); }

function replotCsv() {
  Plotly.restyle('plot-current', { x: [shiftedCsvX()], y: [csvY],  visible: true }, [1]);
  Plotly.restyle('plot-charge',  { x: [shiftedCsvQX()], y: [csvQY], visible: true }, [1]);
}

/* -------------------- ANALYSIS HELPERS -------------------- */

// Basic descriptive stats over (xs, ys)
function basicStats(ys) {
  if (!ys || !ys.length) return null;
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
  const n = ys.length;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const avg = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - avg * avg));
  return { n, min, max, avg, sd };
}

function fmt(v, digits = 1) {
  return (v === null || v === undefined || Number.isNaN(v)) ? '--'
    : (v >= 1e6 ? (v / 1e6).toFixed(digits) + 'M'
      : (v >= 1e3 ? (v / 1e3).toFixed(digits) + 'k'
        : v.toFixed(digits)));
}

function fmtTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '--';
  if (seconds < 60) return seconds.toFixed(0) + ' s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function thresholdViolations(ys) {
  if (cfg.thresholdUA <= 0 || !ys || !ys.length) return 0;
  let c = 0;
  for (const v of ys) if (v > cfg.thresholdUA) c++;
  return c;
}

// Cumulative-quantile (occupancy) data: % of time current >= each level.
function cqData(ys, bins = 64) {
  if (!ys || !ys.length) return { levels: [], prob: [] };
  let lo = Infinity, hi = -Infinity;
  const n = ys.length;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  let span = hi - lo || 1;
  if (span <= 0) span = 1;
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    let b = Math.floor((ys[i] - lo) / span * bins);
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const levels = new Array(bins), prob = new Array(bins);
  let cum = 0;
  for (let b = bins - 1; b >= 0; b--) {
    cum += hist[b];
    levels[b] = lo + span * (b + 0.5) / bins;
    prob[b] = (cum / n) * 100;
  }
  return { levels, prob };
}

function renderCq() {
  const ys = currentAnalysisY();
  const cq = cqData(ys);
  Plotly.react('plot-cq', [{
    x: cq.levels, y: cq.prob, mode: 'lines', fill: 'tozeroy', name: 'Occupancy'
  }],
  themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Time above level (%)', range: [0, 100], autorange: false }
  }));
}

/* -------------------- HISTOGRAM -------------------- */

function histData(ys, bins = 64) {
  if (!ys || !ys.length) return { edges: [], counts: [] };
  let lo = Infinity, hi = -Infinity;
  const n = ys.length;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  let span = hi - lo || 1;
  if (span <= 0) span = 1;
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    let b = Math.floor((ys[i] - lo) / span * bins);
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const edges = new Array(bins + 1), counts = new Array(bins);
  for (let b = 0; b <= bins; b++) edges[b] = lo + span * b / bins;
  for (let b = 0; b < bins; b++) counts[b] = hist[b];
  return { edges, counts };
}

function renderHistogram() {
  const ys = currentAnalysisY();
  const h = histData(ys);
  Plotly.react('plot-hist', [{
    x: h.edges, y: h.counts, type: 'bar',
    marker: { color: 'rgba(79,70,229,0.5)', line: { color: '#4f46e5', width: 1 } },
    name: 'Current distribution'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Samples' }
  }));
}

/* -------------------- FFT (periodogram) -------------------- */

// Iterative in-place radix-2 FFT over real signal. Returns bins up to Nyquist.
function fftSpectrum(xs) {
  const n0 = xs.length;
  if (n0 < 4) return { freq: [], mag: [] };
  // Pad to next power of two
  const n = 1 << Math.ceil(Math.log2(n0));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(xs);

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const trash = re[i]; re[i] = re[j]; re[j] = trash;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] = re[a] + tRe; im[a] = im[a] + tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  // Single-sided magnitude spectrum (bins 0 .. Nyquist)
  const half = n / 2 + 1;
  const freq = new Array(half), mag = new Array(half);
  for (let k = 0; k < half; k++) {
    freq[k] = k;
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n0;
  }
  // Drop the DC bin and normalize frequency by sample spacing below
  return { freq, mag };
}

function renderFft() {
  const src = currentAnalysisSource();
  const n = src.x.length;
  if (n < 8) return;
  const fs = fsPerSample(src.x);     // sampling rate estimate
  if (!fs) return;
  const { freq: binFreq, mag } = fftSpectrum(Float64Array.from(src.y));
  const freqs = binFreq.map(k => k * (fs / (1 << Math.ceil(Math.log2(n)))));
  const Hz = freqs.slice(1);         // drop DC
  const M = mag.slice(1);
  Plotly.react('plot-fft', [{
    x: Hz, y: M, mode: 'lines', name: 'Spectrum'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Frequency (Hz)' },
    yaxis: { title: 'Mag (µA)', type: 'log' }
  }));
}

// Estimate sampling rate from the mean inter-sample time.
function fsPerSample(xs) {
  if (xs.length < 2) return 0;
  let sum = 0, c = 0;
  for (let i = 1; i < xs.length; i++) {
    const dt = xs[i] - xs[i - 1];
    if (dt > 0) { sum += dt; c++; }
  }
  if (!c) return 0;
  const avgDt = sum / c;
  return avgDt > 0 ? 1 / avgDt : 0;
}

/* -------------------- ANALYSIS DATA SOURCE -------------------- */

// Provides {x, y} for the analysis charts. Uses the full retained history
// when viewing memory, otherwise the live window.
function currentAnalysisSource() {
  if (isViewingMemory && curRows.length) {
    const x = new Array(curRows.length), y = new Array(curRows.length);
    for (let i = 0; i < curRows.length; i++) {
      x[i] = curRows[i].t;
      y[i] = curRows[i].current_uA;
    }
    return { x, y };
  }
  return { x: liveX, y: liveY };
}

function currentAnalysisY() {
  if (isViewingMemory && curRows.length) {
    return curRows.map(r => r.current_uA);
  }
  return liveY;
}

function renderAnalysisPlots() {
  renderCq();
  renderHistogram();
  renderFft();
}

function renderLiveStats() {
  const s = basicStats(liveY);
  if (!s) return;
  stAvg.textContent = fmt(s.avg);
  stMin.textContent = fmt(s.min);
  stMax.textContent = fmt(s.max);
  stSd.textContent = fmt(s.sd, 2);
  const charge = liveQY.length ? liveQY[liveQY.length - 1] : 0;
  stCharge.textContent = fmt(charge, 2);

  // Battery life estimate
  if (cfg.batteryMah > 0 && s.avg > 0) {
    const hours = (cfg.batteryMah * 1000) / s.avg; // mAh / mA
    stBatt.textContent = hours >= 24 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`;
  } else {
    stBatt.textContent = '--';
  }

  // Threshold violations
  const v = thresholdViolations(liveY);
  if (cfg.thresholdUA > 0) {
    stViol.style.display = '';
    stViol.textContent = `${v} ≥ ${fmt(cfg.thresholdUA)} µA`;
    stViol.style.opacity = v > 0 ? 1 : 0.45;
  } else {
    stViol.style.display = 'none';
  }
}

/* -------------------- REGION ANALYSIS -------------------- */

function currentShapes(plotId) {
  const shapes = [];
  // Threshold horizontal line (current + charge plots)
  if (cfg.thresholdUA > 0) {
    shapes.push({
      type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y',
      y0: cfg.thresholdUA, y1: cfg.thresholdUA,
      line: { dash: 'dash', color: '#ef4444', width: 1 }
    });
  }
  // Region cursors (current plot only)
  if (plotId === 'plot-current' && regionActive) {
    const [lo, hi] = regionBounds;
    if (lo !== null) {
      if (hi !== null && hi > lo) {
        shapes.push({
          type: 'rect', yref: 'paper', y0: 0, y1: 1, xref: 'x',
          x0: lo, x1: hi,
          fillcolor: 'rgba(14,165,233,0.08)', line: { width: 0 }
        });
      }
      for (const x of [lo, hi]) {
        if (x === null) continue;
        shapes.push({
          type: 'line', yref: 'paper', y0: 0, y1: 1, xref: 'x',
          x0: x, x1: x, editable: true,
          line: { dash: 'dot', color: '#0ea5e9', width: 1 },
          name: 'region-cursor'
        });
      }
    }
  }
  return shapes;
}

function currentAnnotations() {
  const ann = [];
  // Manual point labels
  for (const n of notes) {
    ann.push({
      x: n.t, y: n.y, text: n.text, showarrow: true, arrowhead: 2,
      ax: 20, ay: -30, xref: 'x', yref: 'y',
      font: { color: n.color || '#0f172a', size: 12 }
    });
  }
  // Named region caption
  if (regionActive && regionLabel) {
    const [lo, hi] = regionBounds;
    if (lo !== null && hi !== null && hi > lo) {
      ann.push({
        text: regionLabel, xref: 'x', x: (lo + hi) / 2,
        yref: 'paper', y: 1.05, showarrow: false,
        xanchor: 'center', yanchor: 'bottom',
        font: { color: '#0ea5e9', size: 14, weight: 600 }
      });
    }
  }
  return ann;
}

function readRegionFromShapes() {
  const gd = document.getElementById('plot-current');
  const shapes = (gd && gd.layout && gd.layout.shapes) || [];
  const xs = [];
  for (const s of shapes) {
    if (s.type === 'line' && s.xref === 'x' && s.yref === 'paper' && s.x0 === s.x1) xs.push(s.x0);
  }
  xs.sort((a, b) => a - b);
  regionBounds = xs.length ? [xs[0], xs[1] ?? null] : [null, null];
  computeRegionStats();
}

function computeRegionStats() {
  const [lo, hi] = regionBounds;
  if (!regionActive || lo === null || hi === null || lo >= hi) {
    regionStatsEl.textContent = '';
    return;
  }
  if (!curRows.length) {
    regionStatsEl.textContent = 'No data';
    return;
  }
  // curRows is sorted ascending by t; scan the window
  let n = 0, sum = 0, sumSq = 0, min = Infinity, max = -Infinity, prevT = null, charge = 0;
  for (const r of curRows) {
    if (r.t < lo) { prevT = r.t; continue; }
    if (r.t > hi) break;
    const v = r.current_uA;
    n++; sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (prevT !== null) charge += v * (r.t - prevT) / 3600.0;
    prevT = r.t;
  }
  if (!n) { regionStatsEl.textContent = 'No data in region'; return; }
  const avg = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - avg * avg));
  regionStatsEl.textContent =
    `Region [${lo.toFixed(2)}–${hi.toFixed(2)}s]  avg=${fmt(avg)} µA · min=${fmt(min)} · max=${fmt(max)} · std=${fmt(sd)} · ΔQ=${fmt(charge)} µAh`;
}

/* -------------------- PLOT RENDERING -------------------- */

function renderWindow() {
  if (liveX.length === 0) return;
  const latestT = liveX[liveX.length - 1];
  const cutoffT = Math.max(0, latestT - WINDOW_S);

  let dropIdx = 0;
  while (dropIdx < liveX.length && liveX[dropIdx] < cutoffT) dropIdx++;
  if (dropIdx > 0) {
    liveX.splice(0, dropIdx);
    liveY.splice(0, dropIdx);
    liveQX.splice(0, dropIdx);
    liveQY.splice(0, dropIdx);
  }

  const layoutUpdate = {
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', range: [cutoffT, latestT], autorange: false },
    yaxis: { title: 'Current (µA)', autorange: true }
  };

  Plotly.react('plot-current', [
    { x: [...liveX], y: [...liveY], mode: 'lines', name: 'Live Current' },
    { x: shiftedCsvX(), y: csvY, mode: 'lines', name: 'Log Current', visible: csvLoaded }
  ], themedLayout({ ...layoutUpdate, shapes: currentShapes('plot-current'), annotations: currentAnnotations() }));

  Plotly.react('plot-charge', [
    { x: [...liveQX], y: [...liveQY], mode: 'lines', name: 'Live Charge' },
    { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded }
  ], themedLayout({
    ...layoutUpdate,
    yaxis: { title: 'Charge (µAh)', autorange: true },
    shapes: currentShapes('plot-charge')
  }));
}

function resetPlots() {
  const layoutResetCurrent = {
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', autorange: true },
    yaxis: { title: 'Current (µA)', autorange: true }
  };
  const layoutResetCharge = {
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', autorange: true },
    yaxis: { title: 'Charge (µAh)', autorange: true }
  };

  Plotly.react('plot-current', [
    { x: [], y: [], mode: 'lines', name: 'Live Current' },
    { x: shiftedCsvX(), y: csvY, mode: 'lines', name: 'Log Current', visible: csvLoaded }
  ], themedLayout({ ...layoutResetCurrent, shapes: currentShapes('plot-current'), annotations: currentAnnotations() }));

  Plotly.react('plot-charge', [
    { x: [], y: [], mode: 'lines', name: 'Live Charge' },
    { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded }
  ], themedLayout({ ...layoutResetCharge, shapes: currentShapes('plot-charge') }));

  Plotly.react('plot-hist', [{ x: [], y: [], type: 'bar' }],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Current (µA)' }, yaxis: { title: 'Samples' } }));
  Plotly.react('plot-fft', [{ x: [], y: [], mode: 'lines', name: 'Spectrum' }],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Frequency (Hz)' }, yaxis: { title: 'Mag (µA)', type: 'log' } }));
}

function renderMemory() {
  if (!curRows.length) return;

  const cx = new Array(curRows.length), cy = new Array(curRows.length);
  const qx = new Array(curRows.length), qy = new Array(curRows.length);
  for (let i = 0; i < curRows.length; i++) {
    cx[i] = curRows[i].t;
    cy[i] = curRows[i].current_uA;
    if (curRows[i].q !== undefined) { qx[i] = curRows[i].t; qy[i] = curRows[i].q; }
  }

  const cur = decimate(cx, cy, PLOT_MAX);
  const chr = decimate(qx, qy, PLOT_MAX);

  const layoutCurrent = { margin: { t: 16 }, xaxis: { title: 'Time (s)', autorange: true }, yaxis: { title: 'Current (µA)', autorange: true } };
  const layoutCharge  = { margin: { t: 16 }, xaxis: { title: 'Time (s)', autorange: true }, yaxis: { title: 'Charge (µAh)', autorange: true } };

  Plotly.react('plot-current', [
    { x: cur.x, y: cur.y, mode: 'lines', name: 'Live Current' },
    { x: shiftedCsvX(), y: csvY, mode: 'lines', name: 'Log Current', visible: csvLoaded }
  ], themedLayout({ ...layoutCurrent, shapes: currentShapes('plot-current'), annotations: currentAnnotations() }));

  Plotly.react('plot-charge', [
    { x: chr.x, y: chr.y, mode: 'lines', name: 'Live Charge' },
    { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded }
  ], themedLayout({ ...layoutCharge, shapes: currentShapes('plot-charge') }));

  renderAnalysisPlots();
}

/* -------------------- FLUSH LOOP -------------------- */

setInterval(() => {
  tick++;
  if (!needsUpdate || liveX.length === 0 || isViewingMemory) return;
  needsUpdate = false;
  renderWindow();
  renderLiveStats();
  if (tick % 5 === 0) renderCq();
  if (tick % 5 === 0) renderHistogram();
  if (tick % 20 === 0) renderFft();
}, FLUSH_MS);

/* -------------------- MEASUREMENT -------------------- */

function handleMeasurement(batch) {
  // 1. Infinite-ish memory storage (bounded) for CSV exports and Memory plotting
  for (let i = 0; i < batch.x.length; i++) {
    curRows.push({ t: batch.x[i], current_uA: batch.y[i], q: batch.q[i] });
  }
  capMemory();

  // 2. Feed the high-speed rendering buffer
  for (let i = 0; i < batch.x.length; i++) {
    liveX.push(batch.x[i]);
    liveY.push(batch.y[i]);
    liveQX.push(batch.x[i]);
    liveQY.push(batch.q[i]);
  }

  needsUpdate = true;
}

function resetData() {
  curRows = [];
  liveX.length = liveY.length = 0;
  liveQX.length = liveQY.length = 0;

  isViewingMemory = false; // Release memory lock
  needsUpdate = false;

  regionActive = false;
  regionBounds = [null, null];
  const regionBtn = document.getElementById('regionBtn');
  if (regionBtn) { regionBtn.classList.remove('active'); regionBtn.textContent = 'Region Cursors'; }
  if (regionStatsEl) regionStatsEl.textContent = '';

  resetPlots();
}

/* -------------------- CSV -------------------- */

loadCsvBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    parseCsvData(text);
  };
  input.click();
});

clearCsvBtn.addEventListener('click', () => {
  csvX.length = csvY.length = 0;
  csvQX.length = csvQY.length = 0;
  csvLoaded = false;
  csvTimeOffset = 0;
  csvOffsetInput.value = '0';
  csvOffsetControl.style.display = 'none';
  Plotly.restyle('plot-current', { visible: false }, [1]);
  Plotly.restyle('plot-charge', { visible: false }, [1]);
});

function parseCsvData(csvContent) {
  const lines = csvContent.trim().split('\n');

  // Full-resolution working arrays used only to build charge + decimate
  const rawX = [], rawY = [], rawQ = [];
  let last = null;
  let q = 0;

  for (let i = 1; i < lines.length; i++) {
    const [tStr, iStr] = lines[i].split(',');
    const t = parseFloat(tStr);
    const current_uA = parseFloat(iStr);
    if (isNaN(t) || isNaN(current_uA)) continue;

    rawX.push(t);
    rawY.push(current_uA);
    if (last !== null) q += current_uA * (t - last) / 3600.0;
    last = t;
    rawQ.push(q);
  }

  // Decimate once at import; keeps shifted/plotting cheap.
  const cur = decimate(rawX, rawY, PLOT_MAX);
  const chr = decimate(rawX, rawQ, PLOT_MAX); // reuse time axis
  csvX = cur.x; csvY = cur.y;
  csvQX = chr.x; csvQY = chr.y;

  csvTimeOffset = 0;
  csvOffsetInput.value = '0';
  csvOffsetControl.style.display = 'flex';
  csvLoaded = true;
  replotCsv();
}

/* -------------------- EXPORT -------------------- */

exportCsvBtn.addEventListener('click', () => {
  if (!curRows.length) return alert('No data');
  const header = 'time [s],current [µA]\n';
  const body = curRows.map(r => `${r.t},${r.current_uA}`).join('\n');
  download(new Blob([header + body], { type: 'text/csv' }), 'metashunt.csv');
});

exportImgsBtn.addEventListener('click', async () => {
  const cur = document.getElementById('plot-current');
  const chg = document.getElementById('plot-charge');
  download(await Plotly.toImage(cur, { format: 'png' }), 'current.png');
  download(await Plotly.toImage(chg, { format: 'png' }), 'charge.png');
});

function download(blobOrUrl, name) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = name;
  a.click();
}

/* -------------------- STATUS -------------------- */

function setStatus(s) {
  statusTextEl.textContent = s;
  statusEl.classList.remove('ready', 'connecting', 'running', 'error');

  if (s.startsWith('Connected')) {
    deviceInfoEl.textContent = 'MetaShunt V2 connected';
  }

  if (s.startsWith('Running')) {
    statusEl.classList.add('running');
  } else if (s.startsWith('Burst complete')) {
    statusEl.classList.add('connecting');
  } else if (s.startsWith('Connected') || s.startsWith('Found') || s.startsWith('Burst requested') || s.startsWith('Continuous')) {
    statusEl.classList.add('connecting');
  } else if (s.startsWith('Error')) {
    statusEl.classList.add('error');
  } else {
    statusEl.classList.add('ready');
  }

  if (s === 'Stopped') {
    deviceInfoEl.textContent = 'Not connected';
    statusEl.classList.add('ready');
  }
}

/* -------------------- DOM CONTENT LOADED -------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const modeSel = document.getElementById('mode');
  const burstHz = document.getElementById('burstHz');
  const triggerSel = document.getElementById('trigger');
  const trigCurrent = document.querySelector('.trig-current');
  const trigStage = document.querySelector('.trig-stage');
  const triggerUA = document.getElementById('triggerUA');
  const stageIndex = document.getElementById('stageIndex');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');

  burstHz.min = 500; // hardware is 500 Hz-quantized

  /* -------------------- THEME TOGGLE -------------------- */

  const themeToggle = document.getElementById('themeToggle');
  const applyTheme = (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggle.textContent = dark ? 'Light' : 'Dark';
    try { localStorage.setItem('metashunt-theme', dark ? 'dark' : 'light'); } catch (e) {}
    // Re-render charts so Plotly follows the theme colors.
    if (isViewingMemory && curRows.length) renderMemory();
    else if (liveX.length) { needsUpdate = false; renderWindow(); }
    renderCq(); renderHistogram(); renderFft();
  };
  themeToggle.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!dark);
  });
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('metashunt-theme'); } catch (e) {}
  applyTheme(savedTheme === 'dark');

  /* -------------------- LABELS COLLAPSE -------------------- */

  const labelsPanel = document.getElementById('labelsPanel');
  const collapseLabelsBtn = document.getElementById('collapseLabelsBtn');
  collapseLabelsBtn.addEventListener('click', () => {
    const open = labelsPanel.classList.toggle('open');
    collapseLabelsBtn.textContent = open ? 'Labels ▴' : 'Labels ▾';
  });

  let uiRunning = false;

  function setUiRunning(running) {
    uiRunning = running;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
  }
  setUiRunning(false);

  function applyOffset(delta) {
    csvTimeOffset = parseFloat(csvOffsetInput.value) + delta;
    csvOffsetInput.value = csvTimeOffset.toFixed(1);
    replotCsv();
  }

  csvOffsetInput.addEventListener('change', () => {
    csvTimeOffset = parseFloat(csvOffsetInput.value) || 0;
    replotCsv();
  });
  csvOffsetUp.addEventListener('click',   () => applyOffset(+parseFloat(csvOffsetInput.step)));
  csvOffsetDown.addEventListener('click', () => applyOffset(-parseFloat(csvOffsetInput.step)));

  /* -------------------- INITIAL PLOTS -------------------- */

  const liveTrace = { x: [], y: [], mode: 'lines', name: 'Live Current' };
  const csvTrace  = { x: [], y: [], mode: 'lines', name: 'Log Current', visible: false };

  Plotly.newPlot('plot-current', [liveTrace, csvTrace],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Current (µA)' } }),
    { displaylogo: false, responsive: true }
  );

  const liveCharge = { x: [], y: [], mode: 'lines', name: 'Live Charge' };
  const csvCharge  = { x: [], y: [], mode: 'lines', name: 'Log Charge', visible: false };

  Plotly.newPlot('plot-charge', [liveCharge, csvCharge],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Charge (µAh)' } }),
    { displaylogo: false, responsive: true }
  );

  Plotly.newPlot('plot-cq', [{
    x: [], y: [], mode: 'lines', fill: 'tozeroy', name: 'Occupancy'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Time above level (%)', range: [0, 100], autorange: false }
  }), { displaylogo: false, responsive: true });

  Plotly.newPlot('plot-hist', [{
    x: [], y: [], type: 'bar',
    marker: { color: 'rgba(79,70,229,0.5)', line: { color: '#4f46e5', width: 1 } }
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Samples' }
  }), { displaylogo: false, responsive: true });

  Plotly.newPlot('plot-fft', [{
    x: [], y: [], mode: 'lines', name: 'Spectrum'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Frequency (Hz)' },
    yaxis: { title: 'Mag (µA)', type: 'log' }
  }), { displaylogo: false, responsive: true });

  /* -------------------- START / STOP -------------------- */

  startBtn.addEventListener('click', async () => {
    if (uiRunning) return;
    try {
      resetData();
      if (!device.port) {
        await device.connect();
      }

      const opts = {
        mode: modeSel.value,
        burstHz: parseInt(burstHz.value),
        trigger: triggerSel.value,
        triggerUA: parseFloat(triggerUA.value),
        stageIndex: parseInt(stageIndex.value)
      };

      setUiRunning(true);
      await device.start(opts);
      setStatus('Running...');
    } catch (err) {
      console.error(err);
      setUiRunning(false);
      setStatus(`Error: ${err.message}`);
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!uiRunning) return;
    setUiRunning(false);
    await device.stop();
  });

  /* -------------------- ANALYSIS CONTROLS -------------------- */

  const thresholdInput = document.getElementById('thresholdUA');
  const batteryInput  = document.getElementById('batteryMah');
  const regionBtn     = document.getElementById('regionBtn');

  thresholdInput.addEventListener('change', () => {
    cfg.thresholdUA = parseFloat(thresholdInput.value) || 0;
    refreshPlots();
  });
  thresholdInput.addEventListener('input', () => {
    cfg.thresholdUA = parseFloat(thresholdInput.value) || 0;
    refreshPlots();
  });
  batteryInput.addEventListener('change', () => {
    cfg.batteryMah = parseFloat(batteryInput.value) || 0;
    renderLiveStats();
  });

  function setRegion(enabled) {
    regionActive = enabled;
    if (enabled) {
      const latest = liveX.length ? liveX[liveX.length - 1] : 1;
      regionBounds = [0, Math.max(0.001, latest)];
    } else {
      regionBounds = [null, null];
    }
    regionBtn.classList.toggle('active', enabled);
    regionBtn.textContent = enabled ? 'Region: drag cursors' : 'Region Cursors';
    regionStatsEl.textContent = enabled ? 'Drag the two blue cursors' : '';
    refreshPlots();
  }
  regionBtn.addEventListener('click', () => setRegion(!regionActive));

  function refreshPlots() {
    if (isViewingMemory) { renderMemory(); }
    else {
      needsUpdate = false;
      renderWindow();
    }
  }

  // Respond to cursor dragging on the current plot
  document.getElementById('plot-current').on('plotly_relayout', readRegionFromShapes);

  /* -------------------- MANUAL LABELS (8a / 8b) -------------------- */

  const labelText = document.getElementById('labelText');
  const addLabelBtn = document.getElementById('addLabelBtn');
  const setRegionLabelBtn = document.getElementById('setRegionLabelBtn');
  const clearLabelsBtn = document.getElementById('clearLabelsBtn');

  // Capture where the user clicked so "Add Label" can anchor there.
  document.getElementById('plot-current').on('plotly_click', (e) => {
    const pt = e.points && e.points[0];
    if (pt && pt.x !== undefined) lastClickT = pt.x;
  });

  addLabelBtn.addEventListener('click', () => {
    const text = labelText.value.trim();
    if (!text) return alert('Enter label text first');
    // Anchor at last click, else the visible window center, else 0.
    let t = lastClickT;
    if (t === null || t === undefined) {
      t = liveX.length ? (liveX[liveX.length - 1] + (liveX[0] || 0)) / 2 : 0;
    }
    // Use current measurement value at that time as the y anchor.
    let y = null;
    if (liveY.length) y = liveY[liveY.length - 1];
    notes.push({ id: Date.now(), t, y, text, color: '#0f172a' });
    labelText.value = '';
    refreshPlots();
  });

  setRegionLabelBtn.addEventListener('click', () => {
    const text = labelText.value.trim();
    if (!regionActive) return alert('Enable Region Cursors first');
    if (!text) return alert('Enter a label first');
    regionLabel = text;
    labelText.value = '';
    refreshPlots();
  });

  clearLabelsBtn.addEventListener('click', () => {
    notes = [];
    regionLabel = '';
    refreshPlots();
  });

  /* -------------------- MEMORY VIEW -------------------- */

  plotMemoryBtn.addEventListener('click', () => {
    if (isViewingMemory) {
      // Exit back to the live window
      isViewingMemory = false;
      plotMemoryBtn.textContent = 'View Entire Dataset';
      renderWindow();
      if (liveX.length) needsUpdate = true;
      return;
    }
    if (!curRows.length) return alert('No data in memory');

    isViewingMemory = true;   // Lock so the flush loop doesn't overwrite this view
    plotMemoryBtn.textContent = 'Exit Dataset View';
    renderMemory();
  });

  /* -------------------- UI LOGIC -------------------- */

  function onTriggerChange() {
    const t = triggerSel.value;
    trigCurrent.style.display = (t === 'rising' || t === 'falling') ? 'flex' : 'none';
    trigStage.style.display = (t === 'stage') ? 'flex' : 'none';
  }

  modeSel.addEventListener('change', () => {
    const isBurst = modeSel.value === 'burst';
    document.querySelectorAll('.mode-burst').forEach(n => n.style.display = isBurst ? 'flex' : 'none');
    onTriggerChange();
  });

  triggerSel.addEventListener('change', onTriggerChange);

  onTriggerChange();
});