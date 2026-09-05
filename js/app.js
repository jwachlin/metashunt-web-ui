import { MetaShuntSerial } from './webSerial.js';
import { SampleStore, Decimator } from './sampleStore.js';
import { freshModel, parseModel, simulateModel } from './powerModel.js';

/* -------------------- DOM -------------------- */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const deviceInfoEl = document.getElementById('deviceInfo');

const loadCsvBtn = document.getElementById('loadCsvBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportImgsBtn = document.getElementById('exportImgsBtn');
const plotMemoryBtn = document.getElementById('plotMemoryBtn');

/* -------------------- DEVICE -------------------- */

const device = new MetaShuntSerial();

device.onData(handleMeasurement);
device.onStatus(setStatus);

/* -------------------- DATA -------------------- */

let curRows = new SampleStore();      // compact decimated/raw retained history
let rawCount = 0;                     // total datapoints received this run
let decimEnabled = false;             // user toggled decimation
let decimIntensity = 0.01;            // fraction (0.001..0.10)
let decimator = new Decimator(decimIntensity);

// Dedicated visual buffers for the sliding window
let liveX = [], liveY = [];
let liveQX = [], liveQY = [];

// Imported log overlays (decimated so plotting/shifting stays cheap)
let csvLogs = [];   // { id, name, color, x, y, qx, qy, tOffset, qOffset }
let logIdSeq = 0;

const FLUSH_MS = 50;
const WINDOW_S = 10;         // sliding window length (seconds)
const MAX_MEMORY = 2000000;  // cap for retained history records
const PLOT_MAX = 60000;      // max points rendered per plot per trace

let needsUpdate = false;
let isViewingMemory = false; // Lock to prevent live data from overwriting memory plots
let tick = 0;

/* -------------------- ANALYSIS CONFIG/STATE -------------------- */

const cfg = { batteryMah: 0 };
let regionActive = false;
let regionBounds = [null, null]; // [xLo, xHi] seconds
let pendingRegion = 0;           // 0=off, 1=awaiting first click, 2=awaiting second click

// Live stats DOM
const stAvg   = document.getElementById('stAvg');
const stMin   = document.getElementById('stMin');
const stMax   = document.getElementById('stMax');
const stSd    = document.getElementById('stSd');
const stCharge= document.getElementById('stCharge');
const stBatt  = document.getElementById('stBatt');
let regionStatsEl = document.getElementById('regionStats');
let stLiveVal = document.getElementById('stLiveVal');
let stLiveUnit = document.getElementById('stLiveUnit');
let hintCq = document.getElementById('hint-cq');
let hintCDist = document.getElementById('hint-cdist');
let hintCharge = document.getElementById('hint-charge');
let hintHist = document.getElementById('hint-hist');
let hintFft = document.getElementById('hint-fft');
let stDecim = document.getElementById('stDecim');
let stDecimPct = document.getElementById('stDecimPct');
let stPoints = document.getElementById('stPoints');
let stRecPts = document.getElementById('stRecPts');
let stRawPts = document.getElementById('stRawPts');
let stStored = document.getElementById('stStored');
let stStoredPts = document.getElementById('stStoredPts');
let stStoredMem = document.getElementById('stStoredMem');

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
  curRows.subsample(step);
}

const LOG_COLORS = ['#e11d48', '#d97706', '#16a34a', '#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#059669'];

function logCurrentTrace(log) {
  return {
    x: log.x.map(v => v + log.tOffset),
    y: log.y,
    mode: 'lines', name: log.name,
    line: { color: log.color },
    visible: true
  };
}

function logChargeTrace(log) {
  return {
    x: log.qx.map(v => v + log.tOffset),
    y: log.qy.map(v => v + log.qOffset),
    mode: 'lines', name: log.name,
    line: { color: log.color },
    visible: true
  };
}

function csvCurrentTraces() { return csvLogs.map(logCurrentTrace); }
function csvChargeTraces()  { return csvLogs.map(logChargeTrace); }

/* -------------------- DEVICE MODEL OVERLAY -------------------- */

const MODEL_COLOR = '#a855f7';      // purple, distinct from measurements
let deviceModel = null;             // the editable model spec {battery, ...}
let modelSim = null;                // { time[], current_uA[], charge_uAh[] } result

function modelCurrentTraces() {
  if (!modelSim || !deviceModel) return [];
  return [{
    x: modelSim.time,
    y: modelSim.current_uA,
    mode: 'lines',
    name: `Model: ${deviceModel.name}`,
    line: { color: MODEL_COLOR, dash: 'dash', width: 2 },
    visible: true
  }];
}

function modelChargeTraces() {
  if (!modelSim || !deviceModel) return [];
  return [{
    x: modelSim.time,
    y: modelSim.charge_uAh,
    mode: 'lines',
    name: `Model: ${deviceModel.name}`,
    line: { color: MODEL_COLOR, dash: 'dash', width: 2 },
    visible: true
  }];
}

function generateModel() {
  if (!deviceModel) return;
  modelSim = simulateModel(deviceModel);
  // Update status line
  const st = document.getElementById('modelStatus');
  if (st) {
    const n = modelSim.time.length;
    const dur = modelSim.time.length ? modelSim.time[modelSim.time.length - 1].toFixed(1) : 0;
    st.textContent = `Generated ${n} pts over ${dur} s (dashed purple).`;
  }
  replotCsv();
}

function replotCsv() {
  if (isViewingMemory && curRows.length) renderMemory();
  else renderWindow();
}

/* -------------------- DEVICE MODEL BUILDER UI -------------------- */

function mdlEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function mdlInput(type, value, onInput) {
  const inp = document.createElement('input');
  inp.type = type;
  inp.value = value;
  inp.addEventListener('input', () => onInput(inp.value));
  return inp;
}

// Number input clamped to a minimum (default 0 = non-negative).
function mdlNum(value, min, onInput) {
  const inp = mdlInput('number', value, v => onInput(parseFloat(v) || min));
  inp.min = String(min);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v < min) inp.value = String(min);
  });
  return inp;
}

function mdlSelect(options, value, onInput) {
  const sel = document.createElement('select');
  for (const { v, l } of options) {
    const op = document.createElement('option');
    op.value = v; op.textContent = l;
    sel.appendChild(op);
  }
  sel.value = value;
  sel.addEventListener('change', () => onInput(sel.value));
  return sel;
}

function mdlField(label, control) {
  const f = mdlEl('div', 'mdl-field');
  const l = mdlEl('label', null, label);
  f.append(l, control);
  return f;
}

function buildComponentEditor(container, component, onCommit) {
  const row = mdlEl('div', 'mdl-rep-row');
  const name = mdlInput('text', component.name, v => { component.name = v; onCommit(); });
  name.title = 'Component Name';
  name.style.width = '120px';
  const mode = mdlInput('text', component.mode_name, v => { component.mode_name = v; onCommit(); });
  mode.title = 'Mode';
  mode.style.width = '90px';
  const curGroup = currentEditor(component, { onCommit });
  const cur = curGroup.input, unitSel = curGroup.unitSel;
  row.append(mdlEl('span', 'log-label', 'Name'), name);
  row.append(mdlEl('span', 'log-label', 'Mode'), mode);
  row.append(mdlEl('span', 'log-label', 'Current'), cur, unitSel);
  container.appendChild(row);
}

// Shared 'current' editor: number input + nA/µA/mA dropdown. Stores mA in the
// model object (core always mA; unit is a UI-editing convenience, default µA).
const CURRENT_UNITS = [
  { v: 'nA', l: 'nA', mult: 0.000001 },
  { v: 'µA', l: 'µA', mult: 0.001 },
  { v: 'mA', l: 'mA', mult: 1 }
];

function currentEditor(obj, opts = {}) {
  // By default edits obj.current_ma (components). For the regulator, opts can
  // map to a different mA field: { get: () => reg.quiescent_current_ma, set: v => ... }.
  const onCommit = opts.onCommit || (() => {});
  const getMa = opts.get ? opts.get : () => (typeof obj.current_ma === 'number' ? obj.current_ma : 0);
  const setMa = opts.set ? opts.set : (v) => { obj.current_ma = v; };

  const baseMa = getMa();
  // Default display unit is µA (user asked), only switch to an explicit stored unit if present.
  const unit = obj._displayUnit || 'µA';
  const mult = CURRENT_UNITS.find(u => u.v === unit).mult;

  const input = mdlNum(baseMa / mult, 0, v => {
    const m = CURRENT_UNITS.find(u => u.v === unitSel.value).mult;
    setMa(Math.max(0, v) * m);
    obj._displayUnit = unitSel.value;
    onCommit();
  });
  input.title = 'Current';
  input.style.width = '80px';

  const unitSel = mdlSelect(CURRENT_UNITS, unit, v => {
    const newMult = CURRENT_UNITS.find(u => u.v === v).mult;
    // Reinterpret the typed number in the new unit (keep the display number).
    const shown = parseFloat(input.value);
    if (Number.isFinite(shown)) setMa(shown * newMult);
    obj._displayUnit = v;
    onCommit();
  });
  unitSel.title = 'Unit';
  unitSel.style.width = '58px';

  return { input, unitSel };
}

function buildStageEditor(container, stage, onCommit, onAddComponent, onRemoveComponent) {
  const block = mdlEl('div', 'mdl-block');
  const hdr = mdlEl('div', 'mdl-block-title');
  const name = mdlInput('text', stage.name || 'Stage', v => { stage.name = v; onCommit(); });
  name.title = 'Stage Name'; name.style.width = '120px';
  const dur = mdlNum(stage.delta_t_sec, 0.000001, v => {
    stage.delta_t_sec = Math.max(1e-6, v || 0.001);
    onCommit();
  });
  dur.title = 'Duration (s)'; dur.style.width = '70px';
  const addC = mdlEl('button', 'mdl-add', '+ Add Component');
  addC.addEventListener('click', () => onAddComponent());
  hdr.append(name, dur, mdlEl('span', null, 's'), addC);
  block.appendChild(hdr);
  const comps = mdlEl('div', null);
  block.appendChild(comps);
  stage.components.forEach((c, i) => {
    buildComponentEditor(comps, c, onCommit);
    const rm = mdlEl('button', 'mdl-btn mdl-remove', '✕');
    rm.title = 'Remove Component';
    rm.style.marginLeft = '4px';
    rm.addEventListener('click', () => onRemoveComponent(i));
    comps.lastElementChild.appendChild(rm);
  });
  container.appendChild(block);
}

// New stage for a thread: deep-copies the previous stage's components (names,
// modes, currents) so repeated stages are quick to set up.
function cloneStageFrom(lastStage) {
  const src = lastStage || { components: [] };
  return {
    name: (src.name || 'Stage'),
    delta_t_sec: typeof src.delta_t_sec === 'number' ? src.delta_t_sec : 1.0,
    components: src.components.map(c => ({
      name: c.name || 'Component',
      mode_name: c.mode_name || 'Active',
      current_ma: c.current_ma || 0
    }))
  };
}

function buildThreadEditor(container, thread, onCommit, onAddStage, onRemove) {
  const block = mdlEl('div', 'mdl-block');
  const hdr = mdlEl('div', 'mdl-block-title');
  const name = mdlInput('text', thread.name, v => { thread.name = v; onCommit(); });
  name.title = 'Thread Name'; name.style.width = '140px';
  const addS = mdlEl('button', 'mdl-add', '+ Add Stage');
  addS.addEventListener('click', () => onAddStage());
  const rm = mdlEl('button', 'mdl-btn mdl-remove', '✕ Thread');
  rm.addEventListener('click', () => onRemove());
  hdr.append(name, addS, rm);
  block.appendChild(hdr);
  const stages = mdlEl('div', 'mdl-inner');
  block.appendChild(stages);
  thread.stages.forEach((s, si) => buildStageEditor(stages, s, onCommit,
    () => {
      thread.stages[si].components.push({ name: 'Component', mode_name: 'Active', current_ma: 1.0 });
      renderModelForm();
    },
    (ci) => {
      thread.stages[si].components.splice(ci, 1);
      renderModelForm();
    }
  ));
  container.appendChild(block);
}

function renderModelForm() {
  const form = document.getElementById('modelForm');
  const m = deviceModel;
  if (!m || !form) return;
  form.innerHTML = '';
  const commit = () => { /* no full re-render needed; model holds references */ };

  const root = mdlEl('div', null);

  // System
  const sysBlock = mdlEl('div', 'mdl-block');
  sysBlock.appendChild(mdlEl('div', 'mdl-block-title', 'System'));
  const sysGrid = mdlEl('div', 'mdl-grid');
  sysGrid.append(
    mdlField('Name', mdlInput('text', m.name, v => { m.name = v; })),
    mdlField('Sim Time (s)', mdlNum(m.sim_time_sec, 0.001, v => { m.sim_time_sec = Math.max(0.001, v || 0.001); }))
  );
  sysBlock.appendChild(sysGrid);
  root.appendChild(sysBlock);

  // Battery
  const b = m.battery;
  const batBlock = mdlEl('div', 'mdl-block');
  batBlock.appendChild(mdlEl('div', 'mdl-block-title', 'Battery'));
  const batGrid = mdlEl('div', 'mdl-grid');
  batGrid.append(
    mdlField('Name', mdlInput('text', b.name, v => { b.name = v; })),
    mdlField('Chemistry', mdlSelect([{ v: 'li-ion', l: 'Li-Ion' }, { v: 'coin-cell', l: 'Coin Cell' }], b.type, v => { b.type = v; })),
    mdlField('Cells', mdlNum(b.number_cells, 1, v => { b.number_cells = Math.max(1, parseInt(v) || 1); })),
    mdlField('Capacity (mAh)', mdlNum(b.capacity_mAh, 0, v => { b.capacity_mAh = Math.max(0, v || 0); })),
    mdlField('Initial Charge (mAh)', mdlNum(b.initial_charge_mAh, 0, v => { b.initial_charge_mAh = Math.max(0, v || 0); })),
    mdlField('Internal R (Ω)', mdlNum(b.internal_resistance_ohm, 0, v => { b.internal_resistance_ohm = Math.max(0, v || 0); }))
  );
  batBlock.appendChild(batGrid);
  root.appendChild(batBlock);

  // Regulator
  const reg = b.regulator;
  const regBlock = mdlEl('div', 'mdl-block');
  regBlock.appendChild(mdlEl('div', 'mdl-block-title', 'Regulator'));
  const regGrid = mdlEl('div', 'mdl-grid');

  const effField = mdlField('Efficiency (0-1)', mdlNum(reg.efficiency, 0.001, v => { reg.efficiency = Math.min(1, Math.max(0.001, v || 0.001)); }));

  const typeSel = mdlSelect([{ v: 'switching', l: 'Switching' }, { v: 'linear', l: 'Linear' }],
    reg.is_switching ? 'switching' : 'linear',
    v => {
      reg.is_switching = v === 'switching';
      if (!reg.is_switching) reg.efficiency = 0;        // linear regs ignore efficiency
      renderModelForm();
    });

  function syncRegEfficiency() {
    effField.style.display = reg.is_switching ? '' : 'none';
  }

  // Quiescent current: number + nA/µA/mA dropdown (stores mA in core field).
  const qGroup = currentEditor(reg, {
    get: () => (typeof reg.quiescent_current_ma === 'number' ? reg.quiescent_current_ma : 0),
    set: v => { reg.quiescent_current_ma = v; },
    onCommit: () => {}
  });

  const qField = mdlEl('div', 'mdl-field');
  const qLabel = mdlEl('label', null, 'Quiescent');
  const qRow = mdlEl('div', 'mdl-rep-row');
  qRow.style.flexWrap = 'nowrap';
  qRow.style.gap = '4px';
  qRow.append(qGroup.input, qGroup.unitSel);
  qField.append(qLabel, qRow);

  regGrid.append(
    mdlField('Name', mdlInput('text', reg.name, v => { reg.name = v; })),
    mdlField('Output Voltage (V)', mdlNum(reg.output_voltage, 0, v => { reg.output_voltage = Math.max(0, v || 0); })),
    mdlField('Type', typeSel),
    effField,
    qField
  );
  syncRegEfficiency();
  regBlock.appendChild(regGrid);
  root.appendChild(regBlock);

  // Threads
  const thrBlock = mdlEl('div', 'mdl-block');
  const thrHdr = mdlEl('div', 'mdl-block-title');
  thrHdr.append(mdlEl('span', null, 'Threads'));
  const addT = mdlEl('button', 'mdl-add', '+ Add Thread');
  addT.addEventListener('click', () => {
    b.regulator.threads.push({ name: `Thread ${b.regulator.threads.length + 1}`, stages: [{ name: 'Stage', delta_t_sec: 1.0, components: [{ name: 'Component', mode_name: 'Active', current_ma: 1.0 }] }] });
    renderModelForm();
  });
  thrHdr.appendChild(addT);
  thrBlock.appendChild(thrHdr);
  const threadsDiv = mdlEl('div', 'mdl-inner');
  thrBlock.appendChild(threadsDiv);
  b.regulator.threads.forEach((th, i) => buildThreadEditor(threadsDiv, th, commit,
    () => {
      th.stages.push(cloneStageFrom(th.stages[th.stages.length - 1]));
      renderModelForm();
    },
    () => {
      b.regulator.threads.splice(i, 1);
      renderModelForm();
    }
  ));
  root.appendChild(thrBlock);

  form.appendChild(root);
}

/* -------------------- IMPORTED LOG LIST UI -------------------- */

const CSV_T_STEP = 0.1;  // seconds
const CSV_Q_STEP = 1.0;  // µAh

function renderLogList() {
  const panel = document.getElementById('logsPanel');
  if (!panel) return;
  panel.innerHTML = '';
  if (!csvLogs.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No Logs Imported.';
    panel.appendChild(empty);
    return;
  }
  for (const log of csvLogs) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.dataset.id = log.id;

    const swatch = document.createElement('span');
    swatch.className = 'log-swatch';
    swatch.style.background = log.color;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'log-name';
    nameInput.value = log.name;
    nameInput.title = 'Rename Log';

    const tLabel = document.createElement('span');
    tLabel.className = 'log-label';
    tLabel.textContent = 't+';

    const tMinus = document.createElement('button');
    tMinus.className = 'ghost small log-btn';
    tMinus.textContent = '−';
    const tInput = document.createElement('input');
    tInput.type = 'number';
    tInput.className = 'log-t';
    tInput.step = CSV_T_STEP;
    tInput.value = log.tOffset;
    const tPlus = document.createElement('button');
    tPlus.className = 'ghost small log-btn';
    tPlus.textContent = '+';

    const qLabel = document.createElement('span');
    qLabel.className = 'log-label';
    qLabel.textContent = 'Q+';

    const qMinus = document.createElement('button');
    qMinus.className = 'ghost small log-btn';
    qMinus.textContent = '−';
    const qInput = document.createElement('input');
    qInput.type = 'number';
    qInput.className = 'log-q';
    qInput.step = CSV_Q_STEP;
    qInput.value = log.qOffset;
    const qPlus = document.createElement('button');
    qPlus.className = 'ghost small log-btn';
    qPlus.textContent = '+';

const remove = document.createElement('button');
      remove.className = 'ghost small log-btn log-remove';
      remove.textContent = '✕';
      remove.title = 'Remove log';

      const fit = document.createElement('button');
      fit.className = 'ghost small log-btn log-fit';
      fit.textContent = 'Re-Fit Data';
      fit.title = 'Align Time to Live via Cross-Correlation, Then Zero Charge at t=0';

      row.append(swatch, nameInput, tLabel, tMinus, tInput, tPlus, qLabel, qMinus, qInput, qPlus, fit, remove);
      panel.appendChild(row);

    // --- Wire controls ---
    nameInput.addEventListener('change', () => { log.name = nameInput.value.trim() || log.name; nameInput.value = log.name; replotCsv(); });

    const applyT = (v) => { log.tOffset = v; tInput.value = v; replotCsv(); };
    tMinus.addEventListener('click', () => applyT(+(parseFloat(tInput.value) || 0) - CSV_T_STEP));
    tPlus .addEventListener('click', () => applyT(+(parseFloat(tInput.value) || 0) + CSV_T_STEP));
    tInput.addEventListener('change', () => applyT(parseFloat(tInput.value) || 0));

    const applyQ = (v) => { log.qOffset = v; qInput.value = v; replotCsv(); };
    qMinus.addEventListener('click', () => applyQ(+(parseFloat(qInput.value) || 0) - CSV_Q_STEP));
    qPlus .addEventListener('click', () => applyQ(+(parseFloat(qInput.value) || 0) + CSV_Q_STEP));
    qInput.addEventListener('change', () => applyQ(parseFloat(qInput.value) || 0));

    remove.addEventListener('click', () => {
      csvLogs = csvLogs.filter(l => l.id !== log.id);
      renderLogList();
      replotCsv();
    });

    fit.addEventListener('click', () => {
      fitLogToLive(log);
      tInput.value = log.tOffset;
      qInput.value = log.qOffset;
      replotCsv();
    });
  }
}

// Linear interpolant over (xs, ys); returns NaN outside the domain.
function makeInterp(xs, ys) {
  const n = xs.length;
  return (t) => {
    if (!n || t < xs[0] || t > xs[n - 1]) return NaN;
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= t) lo = m; else hi = m;
    }
    const x0 = xs[lo], x1 = xs[hi], y0 = ys[lo], y1 = ys[hi];
    const f = (x1 - x0) ? (t - x0) / (x1 - x0) : 0;
    return y0 + (y1 - y0) * f;
  };
}

// Two-pass cross-correlation in time between a log and the live current:
// 1) find shift s maximizing correlation of log(t+s) with live(t),
// 2) then shift Q so the imported log's accumulated charge is 0 µAh at t=0.
function fitLogToLive(log, silent = false) {
  if (!liveX.length) { if (!silent) alert('No Live Data to Fit Against.'); return; }
  if (!log.x.length || !log.y.length) { if (!silent) alert('Imported Log Has No Data.'); return; }

  const logF = makeInterp(log.x, log.y);     // log current at log-time
  const liveF = makeInterp(liveX, liveY);    // live current at abs time
  const t0 = liveX[0], t1 = liveX[liveX.length - 1];
  const l0 = log.x[0], l1 = log.x[log.x.length - 1];

  const corr = (s) => {
    const lo = Math.max(t0, l0 - s);
    const hi = Math.min(t1, l1 - s);
    if (hi <= lo) return -Infinity;
    const N = 400;
    let n = 0, sL = 0, sV = 0;
    const pairs = [];
    for (let i = 0; i <= N; i++) {
      const t = lo + (hi - lo) * i / N;
      const v = liveF(t);
      const l = logF(t + s);
      if (Number.isFinite(v) && Number.isFinite(l)) { pairs.push([v, l]); sV += v; sL += l; n++; }
    }
    if (n < 8) return -Infinity;
    const mV = sV / n, mL = sL / n;
    let num = 0, dV = 0, dL = 0;
    for (const [v, l] of pairs) { num += (v - mV) * (l - mL); dV += (v - mV) ** 2; dL += (l - mL) ** 2; }
    return (dV * dL > 0) ? num / Math.sqrt(dV * dL) : -Infinity;
  };

  const span = Math.min(10, Math.max(t1 - t0, l1 - l0) * 0.5);
  let bestS = 0, bestC = -Infinity;
  for (let s = -span; s <= span; s += 0.05) {
    const c = corr(s);
    if (c > bestC) { bestC = c; bestS = s; }
  }
  // Fine pass around bestS.
  for (let s = bestS - 0.05; s <= bestS + 0.05; s += 0.002) {
    const c = corr(s);
    if (c > bestC) { bestC = c; bestS = s; }
  }

  if (!Number.isFinite(bestC)) { if (!silent) alert('No Overlapping Data to Fit.'); return; }

  log.tOffset = Math.round(-bestS * 1000) / 1000;

  // Charge baseline: imported log accumulated charge should be 0 µAh at t=0.
  // Absolute t=0 is log-time x = -tOffset; interpolate its charge there.
  const qF = makeInterp(log.qx, log.qy);
  const qAtZero = qF(-log.tOffset);
  if (Number.isFinite(qAtZero)) {
    log.qOffset = Math.round(-qAtZero * 1000) / 1000;
  } else {
    // Log doesn't cross t=0 after shift; leave Q as-is.
    log.qOffset = 0;
  }
}

renderLogList();

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

function fmt(v, digits = 2) {
  return (v === null || v === undefined || Number.isNaN(v)) ? '--'
    : (v >= 1e6 ? (v / 1e6).toFixed(digits) + 'M'
      : (v >= 1e3 ? (v / 1e3).toFixed(digits) + 'k'
        : v.toFixed(digits)));
}

// Auto-scaled current: nA -> µA -> mA depending on magnitude.
function formatCurrent(uA) {
  if (uA === null || uA === undefined || Number.isNaN(uA)) return '--';
  const abs = Math.abs(uA);
  if (abs < 1) return `${(uA * 1000).toFixed(2)} nA`;
  if (abs < 1e6) return `${uA.toFixed(2)} µA`;
  return `${(uA / 1e6).toFixed(2)} mA`;
}

function fmtTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '--';
  if (seconds < 60) return seconds.toFixed(0) + ' s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
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
    name: 'Current Distribution'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Samples' }
  }));
}

/* -------------------- CHARGE DISTRIBUTION -------------------- */

// Portion of total charge (%) spent while current sits in each bin.
// q += I(t) * dt accumulated per bin; normalized to sum to 100.
function chargeHistData(xs, ys, bins = 48) {
  const n = xs.length;
  if (n < 2) return { centers: [], frac: [] };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = (hi - lo) || 1;
  if (span <= 0) span = 1;

  const acc = new Float64Array(bins);
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dt = xs[i] - xs[i - 1];
    if (!(dt > 0)) continue;
    const q = ys[i] * dt; // charge ∝ I·Δt  (µA·s)
    let b = Math.floor((ys[i] - lo) / span * bins);
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    acc[b] += q;
    total += q;
  }
  if (total <= 0) return { centers: [], frac: [] };

  const centers = new Array(bins), frac = new Array(bins);
  for (let b = 0; b < bins; b++) {
    centers[b] = lo + span * (b + 0.5) / bins;
    frac[b] = (acc[b] / total) * 100;
  }
  return { centers, frac };
}

function renderChargeDist() {
  const src = currentAnalysisSource();
  const cd = chargeHistData(src.x, src.y);
  Plotly.react('plot-charge-dist', [{
    x: cd.centers, y: cd.frac, type: 'bar',
    marker: { color: '#14b8a6', line: { width: 0 } },
    name: 'Charge Share'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Portion of charge (%)', range: [0, 100], autorange: false }
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
  // FFT requires uniform, full-resolution sampling. Decimated data is neither:
  // show an explanatory overlay instead of computing a meaningless spectrum.
  if (decimEnabled && isViewingMemory) {
    Plotly.react('plot-fft', [], themedLayout({
      margin: { t: 16 },
      xaxis: { title: 'Frequency (Hz)' },
      yaxis: { title: 'Mag (µA)', type: 'log', range: [0, 1] },
      annotations: [{
        text: 'FFT Not Available for Decimated Data.<br>Zoom the Live 10 s View for Spectrum Analysis.',
        showarrow: false, xref: 'paper', yref: 'paper',
        x: 0.5, y: 0.5, xanchor: 'center', yanchor: 'middle',
        font: { color: theme().muted, size: 13 }, align: 'center'
      }]
    }));
    return;
  }

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

// x-range the user is currently zoomed into on the primary plots (or null).
let visibleRange = null;
// y-range the user selected on Current vs Time (or null = autorange).
let visibleYRange = null;
let rangeLock = false;  // guards against our own re-renders feeding relayout

function dataInView(src) {
  if (!visibleRange || !src.x.length) return src;
  const [lo, hi] = visibleRange;
  const fx = [], fy = [];
  for (let i = 0; i < src.x.length; i++) {
    const t = src.x[i];
    if (t >= lo && t <= hi) { fx.push(t); fy.push(src.y[i]); }
  }
  return { x: fx, y: fy };
}

// Provides {x, y} for the analysis charts. Uses the full retained history
// when viewing memory, otherwise the live window; then trimmed to the current
// visible x-range so the analytics match what's zoomed on-screen.
function currentAnalysisSource() {
  let src;
  if (isViewingMemory && curRows.length) {
    const n = curRows.length;
    const x = new Array(n), y = new Array(n);
    for (let i = 0; i < n; i++) { x[i] = curRows.t[i]; y[i] = curRows.i[i]; }
    src = { x, y };
  } else {
    src = { x: liveX, y: liveY };
  }
  return dataInView(src);
}

function currentAnalysisY() {
  return currentAnalysisSource().y;
}

// Subsets curRows to the visible window (as index ranges for store access).
function rowsInView() {
  const out = [];
  if (!visibleRange) {
    for (let i = 0; i < curRows.length; i++) {
      out.push({ t: curRows.t[i], current_uA: curRows.i[i], q: curRows.q[i] });
    }
    return out;
  }
  const [lo, hi] = visibleRange;
  for (let i = 0; i < curRows.length; i++) {
    const t = curRows.t[i];
    if (t >= lo && t <= hi) out.push({ t, current_uA: curRows.i[i], q: curRows.q[i] });
  }
  return out;
}

function renderAnalysisPlots() {
  renderCq();
  renderHistogram();
  renderChargeDist();
  renderFft();
  updateDataSourceHint();
}

function refreshPlots() {
  if (isViewingMemory) { renderMemory(); }
  else {
    needsUpdate = false;
    renderWindow();
  }
  updateDataSourceHint();
}

// Debounced refresh of all four analysis charts (zoom drags fire many events).
let analysisDebounce = null;
function scheduleAnalysis() {
  if (analysisDebounce) clearTimeout(analysisDebounce);
  analysisDebounce = setTimeout(() => {
    analysisDebounce = null;
    renderCq();
    renderHistogram();
    renderChargeDist();
    renderFft();
    updateDataSourceHint();
  }, 120);
}

// Debounced re-render of the primary plots after a zoom gesture settles.
// Re-running react while the user is mid-drag cancels the drag on the charge
// plot, so defer the full render (decimation / CSV overlay) until they release.
let settleDebounce = null;
let lastZoomEvent = 0;
function scheduleRenderSettle() {
  lastZoomEvent = Date.now();
  if (settleDebounce) clearTimeout(settleDebounce);
  settleDebounce = setTimeout(() => {
    settleDebounce = null;
    if (isViewingMemory && curRows.length) renderMemory();
    else renderWindow();
  }, 150);
}

/* ----- Axis linking (deterministic, loop-free) ----- */

// Times at which our own axis writes are in progress. relayout events that fire
// from OUR writes are suppressed so they cannot ping-pong back through
// captureXRange.
let suppressUntil = 0;
function suppressFor(ms) {
  suppressUntil = Date.now() + ms;
}
function isSuppressed() { return Date.now() < suppressUntil; }

let rangeReadDebounce = null;

function validRange(r) {
  return r && Array.isArray(r) && r.length === 2 &&
    Number.isFinite(+r[0]) && Number.isFinite(+r[1]) && +r[0] !== +r[1];
}

function plotAxis(gdId) {
  const gd = document.getElementById(gdId);
  return gd && gd._fullLayout && gd._fullLayout.xaxis;
}

function plotYAxis(gdId) {
  const gd = document.getElementById(gdId);
  return gd && gd._fullLayout && gd._fullLayout.yaxis;
}

function appliedRange(gdId) {
  const ax = plotAxis(gdId);
  return ax && Array.isArray(ax.range) ? ax.range : null;
}

function appliedYRange(gdId) {
  const ay = plotYAxis(gdId);
  return ay && Array.isArray(ay.range) ? ay.range : null;
}

function sameRange(a, b) {
  return a && b &&
    Math.abs(+a[0] - +b[0]) < 1e-6 && Math.abs(+a[1] - +b[1]) < 1e-6;
}

// Drive one plot's applied x-range to target (or autorange if target null).
// No-op when already correct; suppresses events so downstream captureXRange
// ignores the echo we generate.
function setPlotAxis(gdId, target) {
  const cur = appliedRange(gdId);
  const auto = plotAxis(gdId)?.autorange === true;
  if (target) {
    if (!auto && cur && sameRange(cur, target)) return;
    Plotly.relayout(gdId, { xaxis: { range: target, autorange: false } });
    suppressFor(50);
  } else {
    if (auto) return;
    Plotly.relayout(gdId, { xaxis: { autorange: true } });
    suppressFor(50);
  }
}

function setVisibleRange(r) {
  visibleRange = r ? [Math.min(+r[0], +r[1]), Math.max(+r[0], +r[1])] : null;
  updateDataSourceHint();
  const target = visibleRange || null;
  setPlotAxis('plot-current', target);
  setPlotAxis('plot-charge', target);
  scheduleRenderSettle();
}

// The interactive zoom on one plot: capture its applied range, sanitize, mirror
// to the other and update analyses. Also remembers the current plot's y-range so
// the 50ms flush doesn't stomp the y-limits the user selected.
function captureXRange(gdId) {
  if (rangeLock || isSuppressed()) return;
  const cur = appliedRange(gdId);
  if (!validRange(cur)) {
    // Reset/double-click: restoring autorange.
    if (visibleRange !== null) setVisibleRange(null);
    return;
  }
  const r = [Math.min(+cur[0], +cur[1]), Math.max(+cur[0], +cur[1])];
  const same = visibleRange && sameRange(r, visibleRange);
  // Capture the y-range (sanitized) whenever the interacted plot has one.
  const yr = appliedYRange(gdId);
  visibleYRange = (yr && validRange(yr))
    ? [Math.min(+yr[0], +yr[1]), Math.max(+yr[0], +yr[1])]
    : null;
  if (!same) {
    rangeLock = true;
    try {
      setVisibleRange(r);
    } finally {
      rangeLock = false;
    }
  }
  scheduleAnalysis();
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

  // Realtime current (last sample), auto-scaled units.
  if (liveY.length > 0) {
    const last = liveY[liveY.length - 1];
    const formatted = formatCurrent(last);
    stLiveVal.textContent = formatted.replace(/ (nA|µA|mA)$/, '');
    stLiveUnit.textContent = formatted.replace(/.* /, '');
    stLiveVal.parentElement.classList.add('live--on');
  } else {
    stLiveVal.textContent = '--';
    stLiveUnit.textContent = 'µA';
    stLiveVal.parentElement.classList.remove('live--on');
  }

  // Battery life estimate
  if (cfg.batteryMah > 0 && s.avg > 0) {
    const hours = (cfg.batteryMah * 1000) / s.avg; // mAh / mA
    stBatt.textContent = hours >= 24 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`;
  } else {
    stBatt.textContent = '--';
  }

  updateDecimStats();
}

function formatBytes(b) {
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

// Update storage + decimation indicators in the stats bar.
// "Stored" always appears while recording; decimation pills add detail.
function updateDecimStats() {
  const recording = rawCount > 0;
  if (stStored) {
    stStored.style.display = recording ? '' : 'none';
    if (recording) {
      stStoredPts.textContent = curRows.length.toLocaleString();
      stStoredMem.textContent = formatBytes(curRows.memBytes());
    }
  }
  const showDecim = decimEnabled && recording;
  if (stDecim) stDecim.style.display = showDecim ? '' : 'none';
  if (stPoints) stPoints.style.display = showDecim ? '' : 'none';
  if (showDecim) {
    stDecimPct.textContent = (decimIntensity * 100).toFixed(1);
    stRawPts.textContent = rawCount.toLocaleString();
    stRecPts.textContent = curRows.length.toLocaleString();
  }
}

// Update the subtitle that clarifies which data scope each analysis chart uses.
function updateDataSourceHint() {
  let scope;
  if (visibleRange) {
    scope = `Visible ${visibleRange[0].toFixed(2)}–${visibleRange[1].toFixed(2)} s`;
  } else if (isViewingMemory && curRows.length > 0) {
    scope = 'Entire record';
  } else {
    scope = 'Live (last 10 s window)';
  }
  if (decimEnabled && isViewingMemory && !visibleRange) scope += ' (decimated)';
  if (hintCharge) hintCharge.textContent = `Charge — ${scope}`;
  if (hintCq) hintCq.textContent = `Time above level — ${scope}`;
  if (hintHist) hintHist.textContent = `Histogram — ${scope}`;
  if (hintFft) hintFft.textContent = decimEnabled && isViewingMemory ? 'Spectrum — unavailable (decimated)' : `Spectrum — ${scope}`;
  if (hintCDist) hintCDist.textContent = `Charge share — ${scope}`;
}

/* -------------------- REGION ANALYSIS -------------------- */

function currentShapes(plotId) {
  const shapes = [];
  // Region cursors (current plot only) - drawn from our state, not editable
  if (plotId === 'plot-current' && regionActive) {
    const [lo, hi] = regionBounds;
    if (lo !== null) {
      const line = { dash: 'dot', color: '#0ea5e9', width: 2 };
      shapes.push({ type: 'line', yref: 'paper', y0: 0, y1: 1, xref: 'x', x0: lo, x1: lo, line });
      if (hi !== null) {
        if (hi > lo) {
          shapes.push({
            type: 'rect', yref: 'paper', y0: 0, y1: 1, xref: 'x',
            x0: lo, x1: hi,
            fillcolor: 'rgba(14,165,233,0.10)', line: { width: 0 }
          });
        }
        shapes.push({ type: 'line', yref: 'paper', y0: 0, y1: 1, xref: 'x', x0: hi, x1: hi, line });
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
      font: { color: n.color || theme().text, size: 12 }
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

function computeRegionStats() {
  const [lo, hi] = regionBounds;
  if (!regionActive || lo === null || hi === null || lo >= hi) {
    regionStatsEl.textContent = '';
    return;
  }
  if (!curRows.length) {
    regionStatsEl.textContent = 'No Data';
    return;
  }
  // curRows is sorted ascending by t; scan the window
  let n = 0, sum = 0, sumSq = 0, min = Infinity, max = -Infinity, prevT = null, charge = 0;
  const T = curRows.t, I = curRows.i;
  for (let idx = 0; idx < curRows.length; idx++) {
    const tt = T[idx];
    if (tt < lo) { prevT = tt; continue; }
    if (tt > hi) break;
    const v = I[idx];
    n++; sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (prevT !== null) charge += v * (tt - prevT) / 3600.0;
    prevT = tt;
  }
  if (!n) { regionStatsEl.textContent = 'No Data in Region'; return; }
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

  // When the user has zoomed in, preserve their x-range instead of re-sliding.
  const xaxis = visibleRange
    ? { title: 'Time (s)', range: visibleRange, autorange: false }
    : { title: 'Time (s)', range: [cutoffT, latestT], autorange: false };
  renderPrimaryPair(xaxis);
}

// y-axis config for Current vs Time: honors the user's selected y-range and
// does NOT re-autorange on every 50ms flush (which would wipe their zoom).
function yAxisCurrent() {
  return visibleYRange
    ? { title: 'Current (µA)', range: visibleYRange, autorange: false }
    : { title: 'Current (µA)', autorange: true };
}

// Renders both primary plots sharing one x-axis definition, guaranteeing they
// always show the same x-range without racing a separate relayout.
function renderPrimaryPair(xaxis) {
  const themedX = themedLayout({ margin: { t: 16 }, xaxis, yaxis: yAxisCurrent() });
  Plotly.react('plot-current', [
    { x: [...liveX], y: [...liveY], mode: 'lines', name: 'Live Current' },
    ...csvCurrentTraces(),
    ...modelCurrentTraces()
  ], { ...themedX, shapes: currentShapes('plot-current'), annotations: currentAnnotations() });

  Plotly.react('plot-charge', [
    { x: [...liveQX], y: [...liveQY], mode: 'lines', name: 'Live Charge' },
    ...csvChargeTraces(),
    ...modelChargeTraces()
  ], themedLayout({
    margin: { t: 16 },
    dragmode: false,
    xaxis,
    yaxis: { title: 'Charge (µAh)', autorange: true },
    shapes: currentShapes('plot-charge')
  }));
}

function resetPlots() {
  const layoutResetCurrent = {
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', autorange: true },
    yaxis: yAxisCurrent()
  };
  const layoutResetCharge = {
    margin: { t: 16 },
    dragmode: false,
    xaxis: { title: 'Time (s)', autorange: true },
    yaxis: { title: 'Charge (µAh)', autorange: true }
  };

  Plotly.react('plot-current', [
    { x: [], y: [], mode: 'lines', name: 'Live Current' },
    ...csvCurrentTraces(),
    ...modelCurrentTraces()
  ], themedLayout({ ...layoutResetCurrent, shapes: currentShapes('plot-current'), annotations: currentAnnotations() }));

  Plotly.react('plot-charge', [
    { x: [], y: [], mode: 'lines', name: 'Live Charge' },
    ...csvChargeTraces(),
    ...modelChargeTraces()
  ], themedLayout({ ...layoutResetCharge, shapes: currentShapes('plot-charge') }));

  Plotly.react('plot-hist', [{ x: [], y: [], type: 'bar' }],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Current (µA)' }, yaxis: { title: 'Samples' } }));
  Plotly.react('plot-charge-dist', [{ x: [], y: [], type: 'bar' }],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Current (µA)' }, yaxis: { title: 'Portion of charge (%)', range: [0, 100], autorange: false } }));
  Plotly.react('plot-fft', [{ x: [], y: [], mode: 'lines', name: 'Spectrum' }],
    themedLayout({ margin: { t: 16 }, xaxis: { title: 'Frequency (Hz)' }, yaxis: { title: 'Mag (µA)', type: 'log' } }));
}

function renderMemory() {
  if (!curRows.length) return;

  // Build index subset within visible range, else the whole store.
  const T = curRows.t, I = curRows.i, Q = curRows.q;
  const idxs = [];
  if (visibleRange) {
    const [lo, hi] = visibleRange;
    for (let i = 0; i < curRows.length; i++) if (T[i] >= lo && T[i] <= hi) idxs.push(i);
  } else {
    for (let i = 0; i < curRows.length; i++) idxs.push(i);
  }
  if (!idxs.length) {
    // Zoomed to an empty region: clear both primary traces but still apply the
    // x-range (and keep charge in sync) so the axis updates visibly.
    const emptyX = { title: 'Time (s)', range: visibleRange, autorange: false };
    Plotly.react('plot-current', [
      { x: [], y: [], mode: 'lines', name: 'Live Current' },
      ...csvCurrentTraces(),
      ...modelCurrentTraces()
    ], themedLayout({ margin: { t: 16 }, xaxis: emptyX, yaxis: yAxisCurrent() }));
    Plotly.react('plot-charge', [
      { x: [], y: [], mode: 'lines', name: 'Live Charge' },
      ...csvChargeTraces(),
      ...modelChargeTraces()
    ], themedLayout({ margin: { t: 16 }, dragmode: false, xaxis: emptyX, yaxis: { title: 'Charge (µAh)', autorange: true } }));
    renderAnalysisPlots();
    return;
  }

  const cx = new Array(idxs.length), cy = new Array(idxs.length);
  const qx = new Array(idxs.length), qy = new Array(idxs.length);
  for (let k = 0; k < idxs.length; k++) {
    const i = idxs[k];
    cx[k] = T[i];
    cy[k] = I[i];
    qx[k] = T[i];
    qy[k] = Q[i];
  }

  const cur = decimate(cx, cy, PLOT_MAX);
  const chr = decimate(qx, qy, PLOT_MAX);

  const xaxis = visibleRange
    ? { title: 'Time (s)', range: visibleRange, autorange: false }
    : { title: 'Time (s)', autorange: true };

  Plotly.react('plot-current', [
    { x: cur.x, y: cur.y, mode: 'lines', name: 'Live Current' },
    ...csvCurrentTraces(),
    ...modelCurrentTraces()
  ], themedLayout({ margin: { t: 16 }, xaxis, yaxis: yAxisCurrent(), shapes: currentShapes('plot-current'), annotations: currentAnnotations() }));

  Plotly.react('plot-charge', [
    { x: chr.x, y: chr.y, mode: 'lines', name: 'Live Charge' },
    ...csvChargeTraces(),
    ...modelChargeTraces()
  ], themedLayout({ margin: { t: 16 }, dragmode: false, xaxis, yaxis: { title: 'Charge (µAh)', autorange: true }, shapes: currentShapes('plot-charge') }));

  renderAnalysisPlots();
}

/* -------------------- FLUSH LOOP -------------------- */

setInterval(() => {
  tick++;
  if (!needsUpdate || liveX.length === 0 || isViewingMemory) return;
  needsUpdate = false;
  renderWindow();
  renderLiveStats();
  updateDataSourceHint();
  if (tick % 5 === 0) renderCq();
  if (tick % 5 === 0) renderHistogram();
  if (tick % 5 === 0) renderChargeDist();
  if (tick % 20 === 0) renderFft();
}, FLUSH_MS);

/* -------------------- AXIS SYNC SAFETY NET -------------------- */

// Plotly's relayout/react interplay can occasionally drop an axis update for a
// secondary plot. Poll both primary plots' APPLIED (post-layout) x-ranges and
// force the charge plot to follow the current plot whenever they diverge.
setInterval(() => {
  if (rangeLock || isSuppressed()) return;
  // Skip while a zoom gesture is in progress (relayout events are rapid).
  if (Date.now() - lastZoomEvent < 400) return;
  const cur = document.getElementById('plot-current');
  const chg = document.getElementById('plot-charge');
  if (!cur || !chg) return;
  const curAx = cur._fullLayout && cur._fullLayout.xaxis;
  const chgAx = chg._fullLayout && chg._fullLayout.xaxis;
  if (!curAx || !chgAx) return;
  const cr = Array.isArray(curAx.range) ? curAx.range : null;
  const gr = Array.isArray(chgAx.range) ? chgAx.range : null;
  const curAuto = curAx.autorange === true;
  const chgAuto = chgAx.autorange === true;

  // Both already consistent: nothing to do.
  if (curAuto && chgAuto) return;
  if (!curAuto && !chgAuto && gr && sameRange(cr, gr)) return;

  rangeLock = true;
  try {
    if (curAuto || !cr) {
      // Current is auto: restore charge to auto to match.
      if (!chgAuto) setPlotAxis('plot-charge', null);
    } else {
      // Mirror the applied current range onto charge; if a zoom state exists,
      // keep it in visibleRange so analytics follow.
      if (visibleRange !== null) setVisibleRange(cr);
      else setPlotAxis('plot-charge', [Math.min(+cr[0], +cr[1]), Math.max(+cr[0], +cr[1])]);
    }
  } finally {
    rangeLock = false;
  }
}, 300);

/* -------------------- MEASUREMENT -------------------- */

function handleMeasurement(batch) {
  const n = batch.x.length;

  // 1. Retained history (compact store, optionally decimated).
  if (decimEnabled) {
    for (let i = 0; i < n; i++) {
      const d = decimator.step(batch.x[i], batch.y[i], batch.q[i]);
      if (d) curRows.push(d.t, d.i, d.q);
    }
  } else {
    for (let i = 0; i < n; i++) curRows.push(batch.x[i], batch.y[i], batch.q[i]);
  }
  rawCount += n;
  capMemory();

  // 2. Feed the high-speed rendering buffer (always full resolution)
  for (let i = 0; i < n; i++) {
    liveX.push(batch.x[i]);
    liveY.push(batch.y[i]);
    liveQX.push(batch.x[i]);
    liveQY.push(batch.q[i]);
  }

  needsUpdate = true;
}

function resetData() {
  curRows.clear();
  rawCount = 0;
  decimator.reset();
  liveX.length = liveY.length = 0;
  liveQX.length = liveQY.length = 0;

  isViewingMemory = false; // Release memory lock
  needsUpdate = false;

  // Drop any zoom; return to default auto/sliding ranges.
  visibleRange = null;
  visibleYRange = null;
  rangeLock = false;

  regionActive = false;
  regionBounds = [null, null];
  pendingRegion = 0;
  const regionBtn = document.getElementById('regionBtn');
  if (regionBtn) { regionBtn.classList.remove('active'); regionBtn.textContent = 'Region Cursors'; }
  if (regionStatsEl) regionStatsEl.textContent = '';

  updateDecimStats();
  resetPlots();
}

/* -------------------- CSV -------------------- */

loadCsvBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    for (const file of files) {
      const text = await file.text();
      let name = file.name.replace(/\.csv$/i, '').trim() || 'Log';
      const chosen = prompt('Rename Log:', name);
      if (chosen !== null && chosen.trim()) name = chosen.trim();
      parseCsvData(text, name);
    }
    renderLogList();
  };
  input.click();
});

function parseCsvData(csvContent, name) {
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

  csvLogs.push({
    id: ++logIdSeq,
    name,
    // Index by the count *before* push so the first log gets color[0].
    color: LOG_COLORS[csvLogs.length % LOG_COLORS.length],
    x: cur.x, y: cur.y,
    qx: chr.x, qy: chr.y,
    tOffset: 0,
    qOffset: 0
  });

  // Auto-align against live data on import where possible.
  const log = csvLogs[csvLogs.length - 1];
  if (liveX.length) fitLogToLive(log, true);

  if (isViewingMemory && curRows.length) renderMemory();
  else renderWindow();
}

/* -------------------- EXPORT -------------------- */

exportCsvBtn.addEventListener('click', () => {
  if (!curRows.length) return alert('No Data');
  const header = 'time [s],current [µA]\n';
  const rows = [];
  for (let i = 0; i < curRows.length; i++) rows.push(`${curRows.t[i]},${curRows.i[i]}`);
  const body = rows.join('\n');

  const defaultName = `metashunt_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const chosen = prompt('Name for Exported Log:', defaultName);
  const fileName = (chosen && chosen.trim()) ? chosen.trim() : defaultName;
  download(new Blob([header + body], { type: 'text/csv' }), `${fileName}.csv`);
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
    deviceInfoEl.textContent = 'MetaShunt V2 Connected';
  }

  if (s.startsWith('Running')) {
    statusEl.classList.add('running');
  } else if (s.startsWith('Burst Complete')) {
    statusEl.classList.add('connecting');
  } else if (s.startsWith('Connected') || s.startsWith('Found') || s.startsWith('Burst Requested') || s.startsWith('Continuous')) {
    statusEl.classList.add('connecting');
  } else if (s.startsWith('Error')) {
    statusEl.classList.add('error');
  } else {
    statusEl.classList.add('ready');
  }

  if (s === 'Stopped') {
    deviceInfoEl.textContent = 'Not Connected';
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
  const startDemoBtn = document.getElementById('startDemoBtn');
  const stopBtn = document.getElementById('stopBtn');

  burstHz.min = 500; // hardware is 500 Hz-quantized

  /* -------------------- DEVICE MODEL BUTTONS -------------------- */

  const addModelBtn = document.getElementById('addModelBtn');
  const loadModelBtn = document.getElementById('loadModelBtn');
  const generateModelBtn = document.getElementById('generateModelBtn');
  const exportModelBtn = document.getElementById('exportModelBtn');
  const clearModelBtn = document.getElementById('clearModelBtn');
  const modelPlaceholder = document.getElementById('modelPlaceholder');
  const modelArea = document.getElementById('modelArea');

  function openModelForm() {
    modelArea.style.display = '';
    modelPlaceholder.style.display = 'none';
    renderModelForm();
  }
  function closeModelForm() {
    deviceModel = null;
    modelSim = null;
    modelArea.style.display = 'none';
    modelPlaceholder.style.display = '';
    replotCsv();
  }

  addModelBtn.addEventListener('click', () => {
    deviceModel = freshModel();
    openModelForm();
    generateModel();
  });

  loadModelBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const res = parseModel(text);
      if (!res.ok) {
        alert(`Could not load device model:\n${res.error}`);
        return;
      }
      deviceModel = res.model;
      openModelForm();
      generateModel();
    };
    input.click();
  });

  generateModelBtn.addEventListener('click', generateModel);

  exportModelBtn.addEventListener('click', () => {
    if (!deviceModel) return;
    // Strip ephemeral UI-only keys (_displayUnit) so the exported JSON is the
    // clean mA-core model spec.
    const strip = (k, v) => (k === '_displayUnit' ? undefined : v);
    const blob = new Blob([JSON.stringify(deviceModel, strip, 2)], { type: 'application/json' });
    const safeName = (deviceModel.name || 'device-model').replace(/[^\w.-]+/g, '_');
    download(blob, `${safeName}.json`);
  });

  clearModelBtn.addEventListener('click', closeModelForm);

  /* -------------------- DECIMATION CONTROLS -------------------- */

  const decimCtrl = document.getElementById('decimCtrl');
  const decimBtn = document.getElementById('decimBtn');
  const decimSlider = document.getElementById('decimSlider');
  const decimSliderVal = document.getElementById('decimSliderVal');

  function syncDecimUi() {
    if (uiRunning) {
      decimBtn.disabled = true;
    } else {
      decimBtn.disabled = false;
    }
    decimBtn.classList.toggle('active', decimEnabled);
    decimBtn.textContent = decimEnabled ? 'Decimation On' : 'Enable Decimation';
    decimSlider.disabled = decimEnabled || uiRunning;
    updateDecimStats();
  }

  decimBtn.addEventListener('click', () => {
    if (uiRunning) return; // must toggle before starting
    decimEnabled = !decimEnabled;
    decimIntensity = parseFloat(decimSlider.value) / 100;
    decimator = new Decimator(decimIntensity);
    syncDecimUi();
    if (decimEnabled) renderFft();
  });

  decimSlider.addEventListener('input', () => {
    decimIntensity = parseFloat(decimSlider.value) / 100;
    decimSliderVal.textContent = (decimIntensity * 100).toFixed(1) + '%';
    if (decimEnabled) decimator = new Decimator(decimIntensity);
  });

  function showDecimCtrl(show) {
    decimCtrl.style.display = show ? '' : 'none';
    if (!show) { decimEnabled = false; decimator.reset(); syncDecimUi(); }
  }
  showDecimCtrl(modeSel.value === 'continuous');

  /* -------------------- THEME TOGGLE -------------------- */

  const themeToggle = document.getElementById('themeToggle');
  const applyTheme = (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggle.textContent = dark ? 'Light' : 'Dark';
    try { localStorage.setItem('metashunt-theme', dark ? 'dark' : 'light'); } catch (e) {}
    // Re-render charts so Plotly follows the theme colors.
    // renderWindow/renderMemory return early on empty data, so for an
    // idle/empty state fall back to resetPlots (which re-themes the shells).
    if (isViewingMemory && curRows.length) renderMemory();
    else if (liveX.length) { needsUpdate = false; renderWindow(); }
    else resetPlots();
    renderCq(); renderHistogram(); renderChargeDist(); renderFft();
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
  let demoActive = false;
  let demoWorker = null;

  function setUiRunning(running) {
    uiRunning = running;
    startBtn.disabled = running;
    startDemoBtn.disabled = running;
    stopBtn.disabled = !running;
    if (typeof syncDecimUi === 'function') syncDecimUi();
  }
  setUiRunning(false);

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
    themedLayout({ margin: { t: 16 }, dragmode: false, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Charge (µAh)' } }),
    { displaylogo: false, responsive: true, scrollZoom: false, displayModeBar: false, doubleClick: false }
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

  Plotly.newPlot('plot-charge-dist', [{
    x: [], y: [], type: 'bar',
    marker: { color: '#14b8a6', line: { width: 0 } },
    name: 'Charge Share'
  }], themedLayout({
    margin: { t: 16 },
    xaxis: { title: 'Current (µA)' },
    yaxis: { title: 'Portion of charge (%)', range: [0, 100], autorange: false }
  }), { displaylogo: false, responsive: true });

  /* -------------------- START / STOP -------------------- */

  function stopDemo() {
    if (!demoActive) return;
    demoActive = false;
    if (demoWorker) { demoWorker.terminate(); demoWorker = null; }
    setUiRunning(false);
    setStatus('Stopped');
  }

  function startDemo() {
    if (uiRunning) return;
    resetData();
    demoWorker = new Worker('./js/demoWorker.js');
    demoWorker.onmessage = (e) => {
      if (e.data?.type === 'demo-batch') handleMeasurement(e.data.data);
    };
    demoWorker.onerror = (e) => {
      console.error('Demo worker error:', e);
      stopDemo();
      setStatus('Demo Error');
    };
    demoWorker.postMessage({ type: 'start' });
    demoActive = true;
    setUiRunning(true);
    setStatus('Running Demo...');
  }
  startDemoBtn.addEventListener('click', startDemo);

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
    if (demoActive) { stopDemo(); return; }
    setUiRunning(false);
    await device.stop();
  });

  /* -------------------- ANALYSIS CONTROLS -------------------- */

  const batteryInput  = document.getElementById('batteryMah');
  const regionBtn     = document.getElementById('regionBtn');

  batteryInput.addEventListener('change', () => {
    cfg.batteryMah = parseFloat(batteryInput.value) || 0;
    renderLiveStats();
  });

  function setRegion(enabled) {
    regionActive = enabled;
    pendingRegion = enabled ? 1 : 0;  // await first click
    if (enabled) {
      regionBounds = [null, null];    // start empty; user clicks to place
    } else {
      regionBounds = [null, null];
    }
    regionBtn.classList.toggle('active', enabled);
    regionBtn.textContent = enabled ? 'Region: Click 2 Points' : 'Region Cursors';
    regionStatsEl.textContent = enabled ? 'Click First Boundary on the Plot' : '';
    refreshPlots();
  }
  regionBtn.addEventListener('click', () => setRegion(!regionActive));

  // Click-to-place region handled in the MANUAL LABELS block below
  // (single plotly_click listener manages both regions and labels).

  /* -------------------- MANUAL LABELS (8a) -------------------- */

  const setRegionLabelBtn = document.getElementById('setRegionLabelBtn');
  const clearLabelsBtn = document.getElementById('clearLabelsBtn');

  // Inline popover anchored at the click point.
  const popover = document.getElementById('labelPopover');
  const popoverText = document.getElementById('labelPopoverText');
  const popoverAdd = document.getElementById('labelPopoverAdd');
  const popoverCancel = document.getElementById('labelPopoverCancel');
  let popoverAnchor = { x: 0, y: 0 };   // data coords the label is anchored to

  function showPopover(px, py, x, y) {
    popover.style.display = 'flex';
    const xoff = popover.offsetWidth / 2;
    const yoff = popover.offsetHeight + 8;
    popover.style.left = Math.max(8, Math.min(window.innerWidth - popover.offsetWidth - 8, px - xoff)) + 'px';
    popover.style.top = Math.max(8, py - yoff) + 'px';
    popoverAnchor = { x, y };
    popoverText.value = '';
    popoverText.focus();
  }
  function closePopover() { popover.style.display = 'none'; }
  function submitPopover() {
    const text = popoverText.value.trim();
    if (text && popoverAnchor) {
      notes.push({ id: Date.now(), t: popoverAnchor.x, y: popoverAnchor.y, text, color: theme().text });
      refreshPlots();
    }
    closePopover();
  }

  popoverAdd.addEventListener('click', submitPopover);
  popoverCancel.addEventListener('click', closePopover);
  popoverText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPopover();
    else if (e.key === 'Escape') closePopover();
  });

  // Link the primary plots' x-axes: zooming/panning on the CURRENT plot drives
  // the shared x-range; the CHARGE plot is a passive mirror (dragmode:false).
  function onRelayout(id) {
    // Debounce so a drag's trailing events don't churn; read applied state.
    if (rangeLock || isSuppressed()) return;
    clearTimeout(rangeReadDebounce);
    rangeReadDebounce = setTimeout(() => captureXRange(id), 30);
  }
  document.getElementById('plot-current').on('plotly_relayout', () => onRelayout('plot-current'));
  document.getElementById('plot-current').on('plotly_doubleclick', () => {
    if (rangeLock) return;
    rangeLock = true;
    try {
      setVisibleRange(null);
      visibleYRange = null;
      refreshPlots();
    } finally { rangeLock = false; }
    scheduleAnalysis();
  });

  // Label flow: click the plot (when region inactive) opens an inline label
  // popover at the anchor, instead of a dislocated top-panel input.
  document.getElementById('plot-current').on('plotly_click', (e) => {
    const pt = e.points && e.points[0];
    const x = pt && pt.x !== undefined ? pt.x : null;
    const y = pt && pt.y !== undefined ? pt.y : null;

    if (regionActive) {
      // --- Region placement ---
      if (pendingRegion === 1 && x !== null) {
        regionBounds = [x, null];
        pendingRegion = 2;
        regionStatsEl.textContent = 'Now Click the End Boundary on the Plot';
        refreshPlots();
      } else if (pendingRegion === 2 && x !== null) {
        regionBounds = [Math.min(regionBounds[0], x), Math.max(regionBounds[0], x)];
        pendingRegion = 0;
        computeRegionStats();
        refreshPlots();
      }
      return;
    }

    // --- General click: open label popover ---
    const evt = e.event || {};
    const px = evt.clientX != null ? evt.clientX : (pt && pt.x) || 0;
    const py = evt.clientY != null ? evt.clientY : (pt && pt.y) || 0;
    closePopover();
    if (x !== null) showPopover(px, py, x, y);
  });

  setRegionLabelBtn.addEventListener('click', () => {
    if (!regionActive) return alert('Enable Region Cursors First, Then Set Region Caption');
    // Prompt modestly for the caption.
    regionLabel = prompt('Region Caption:', regionLabel || '');
    if (regionLabel === null) regionLabel = '';
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
    if (!curRows.length) return alert('No Data in Memory');

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
    // Decimation only makes sense in continuous mode.
    if (typeof showDecimCtrl === 'function') showDecimCtrl(modeSel.value === 'continuous');
    // Demo only available in continuous mode; stop it if running.
    startDemoBtn.style.display = isBurst ? 'none' : '';
    if (isBurst && demoActive) stopDemo();
  });

  triggerSel.addEventListener('change', onTriggerChange);

  onTriggerChange();
});