import { MetaShuntSerial } from './webSerial.js';

/* -------------------- DOM -------------------- */

const statusEl = document.getElementById('status');
const deviceInfoEl = document.getElementById('deviceInfo');


const loadCsvBtn = document.getElementById('loadCsvBtn');
const clearCsvBtn = document.getElementById('clearCsvBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportImgsBtn = document.getElementById('exportImgsBtn');

/* -------------------- DEVICE -------------------- */

const device = new MetaShuntSerial();

device.onData(handleMeasurement);
device.onStatus(setStatus);

/* -------------------- DATA -------------------- */

let curRows = [];
let curX = [], curY = [];
let qX = [], qY = [];
let lastT = null;
let qAccum_uAh = 0;

let csvRows = [];
let csvX = [], csvY = [];
let csvQX = [], csvQY = [];
let csvLoaded = false;

const FLUSH_MS = 50;

let pendingX = [];
let pendingY = [];
let pendingQX = [];
let pendingQY = [];
let needsUpdate = false;

/* -------------------- PLOTS -------------------- */

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

  const liveTrace = { x: curX, y: curY, mode: 'lines', name: 'Live Current' };
  const csvTrace  = { x: csvX, y: csvY, mode: 'lines', name: 'Log Current', visible: false };

  Plotly.newPlot('plot-current', [liveTrace, csvTrace],
    { margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Current (µA)' } },
    { displaylogo: false }
  );

  const liveCharge = { x: qX, y: qY, mode: 'lines', name: 'Live Charge' };
  const csvCharge  = { x: csvQX, y: csvQY, mode: 'lines', name: 'Log Charge', visible: false };

  Plotly.newPlot('plot-charge', [liveCharge, csvCharge],
    { margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Charge (µAh)' } },
    { displaylogo: false }
  );

  /* -------------------- START / STOP -------------------- */

  startBtn.addEventListener('click', async () => {
    resetData();
    try {
      if (!device.port) {
        await device.connect();
      }

      // Now these variables are guaranteed not to be null
      const opts = {
        mode: modeSel.value,
        burstHz: parseInt(burstHz.value),
        trigger: triggerSel.value,
        triggerUA: parseFloat(triggerUA.value),
        stageIndex: parseInt(stageIndex.value)
      };

      await device.start(opts);
      setStatus('Running...');
    } catch (err) {
      console.error(err);
      console.warn(modeSel.value)
      console.warn(parseInt(burstHz.value))
      console.warn(triggerSel.value)
      console.warn(parseFloat(triggerUA.value))
      console.warn(parseInt(stageIndex.value))
      setStatus(`Error: ${err.message}`);
    }
  });

  stopBtn.addEventListener('click', () => device.stop());

  /* -------------------- UI LOGIC -------------------- */

  function onTriggerChange() {
    const t = triggerSel.value;
    trigCurrent.style.display = (t === 'rising' || t === 'falling') ? 'flex' : 'none';
    trigStage.style.display = (t === 'stage') ? 'flex' : 'none';
  }

  modeSel.addEventListener('change', () => {
    const isBurst = modeSel.value === 'burst';
    document.querySelectorAll('.mode-cont').forEach(n => n.style.display = isBurst ? 'none' : 'flex');
    document.querySelectorAll('.mode-burst').forEach(n => n.style.display = isBurst ? 'flex' : 'none');
    onTriggerChange();
  });

  triggerSel.addEventListener('change', onTriggerChange);

  onTriggerChange();
});

/* -------------------- PLOT FLUSH -------------------- */

setInterval(() => {
  if (!needsUpdate) return;

  Plotly.extendTraces('plot-current',
    { x: [pendingX], y: [pendingY] },
    [0]
  );

  Plotly.extendTraces('plot-charge',
    { x: [pendingQX], y: [pendingQY] },
    [0]
  );

  pendingX.length = 0;
  pendingY.length = 0;
  pendingQX.length = 0;
  pendingQY.length = 0;
  needsUpdate = false;
}, FLUSH_MS);

/* -------------------- MEASUREMENT -------------------- */

function handleMeasurement(d) {
  const { t, current_uA } = d;
  curRows.push(d);

  if (lastT !== null) {
    const dt = t - lastT;
    qAccum_uAh += current_uA * dt / 3600.0;
  }
  lastT = t;

  pendingX.push(t);
  pendingY.push(current_uA);
  pendingQX.push(t);
  pendingQY.push(qAccum_uAh);
  needsUpdate = true;
}

function resetData() {
  curRows = [];
  curX.length = curY.length = 0;
  qX.length = qY.length = 0;
  pendingX.length = pendingY.length = 0;
  pendingQX.length = pendingQY.length = 0;
  lastT = null;
  qAccum_uAh = 0;

  Plotly.restyle('plot-current', { x: [curX], y: [curY] }, [0]);
  Plotly.restyle('plot-charge', { x: [qX], y: [qY] }, [0]);
}

/* -------------------- CSV -------------------- */

loadCsvBtn.addEventListener('click', async () => {
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
  csvRows = [];
  csvX.length = csvY.length = 0;
  csvQX.length = csvQY.length = 0;
  csvLoaded = false;
  Plotly.restyle('plot-current', { visible: false }, [1]);
  Plotly.restyle('plot-charge', { visible: false }, [1]);
});

function parseCsvData(csvContent) {
  const lines = csvContent.trim().split('\n');
  csvRows = [];
  csvX.length = csvY.length = 0;
  csvQX.length = csvQY.length = 0;

  let last = null;
  let q = 0;

  for (let i = 1; i < lines.length; i++) {
    const [tStr, iStr] = lines[i].split(',');
    const t = parseFloat(tStr);
    const current_uA = parseFloat(iStr);
    if (isNaN(t) || isNaN(current_uA)) continue;

    csvRows.push({ t, current_uA });
    csvX.push(t);
    csvY.push(current_uA);

    if (last !== null) q += current_uA * (t - last) / 3600.0;
    last = t;
    csvQX.push(t);
    csvQY.push(q);
  }

  csvLoaded = true;
  Plotly.restyle('plot-current', { x: [csvX], y: [csvY], visible: true }, [1]);
  Plotly.restyle('plot-charge', { x: [csvQX], y: [csvQY], visible: true }, [1]);
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
  statusEl.textContent = s;

  if (s.startsWith('Connected')) {
    deviceInfoEl.textContent = 'MetaShunt V2 connected';
  }

  if (s === 'Stopped') {
    deviceInfoEl.textContent = 'Not connected';
  }
}
