import { MetaShuntSerial } from './webSerial.js';

/* -------------------- DOM -------------------- */

const statusEl = document.getElementById('status');
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

let curRows = [];

// Dedicated visual buffers for the sliding window
let liveX = [], liveY = [];
let liveQX = [], liveQY = [];

let csvRows = [];
let csvX = [], csvY = [];
let csvQX = [], csvQY = [];
let csvLoaded = false;
let csvTimeOffset = 0;

const FLUSH_MS = 50;

let needsUpdate = false;
let isViewingMemory = false; // Lock to prevent live data from overwriting memory plots

function shiftedCsvX()  { return csvX.map(x => x + csvTimeOffset); }
function shiftedCsvQX() { return csvQX.map(x => x + csvTimeOffset); }

function replotCsv() {
  Plotly.restyle('plot-current', { x: [shiftedCsvX()], y: [csvY],  visible: true }, [1]);
  Plotly.restyle('plot-charge',  { x: [shiftedCsvQX()], y: [csvQY], visible: true }, [1]);
}

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

  const liveTrace = { x: liveX, y: liveY, mode: 'lines', name: 'Live Current' };
  const csvTrace  = { x: csvX, y: csvY, mode: 'lines', name: 'Log Current', visible: false };

  Plotly.newPlot('plot-current', [liveTrace, csvTrace],
    { margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Current (µA)' } },
    { displaylogo: false }
  );

  const liveCharge = { x: liveQX, y: liveQY, mode: 'lines', name: 'Live Charge' };
  const csvCharge  = { x: csvQX, y: csvQY, mode: 'lines', name: 'Log Charge', visible: false };

  Plotly.newPlot('plot-charge', [liveCharge, csvCharge],
    { margin: { t: 16 }, xaxis: { title: 'Time (s)' }, yaxis: { title: 'Charge (µAh)' } },
    { displaylogo: false }
  );

  /* -------------------- START / STOP -------------------- */

  startBtn.addEventListener('click', async () => {
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

      await device.start(opts);
      setStatus('Running...');
    } catch (err) {
      console.error(err);
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
  if (!needsUpdate || liveX.length === 0 || isViewingMemory) return;
  needsUpdate = false;

  const latestT = liveX[liveX.length - 1];
  const windowSizeS = 10;
  
  const cutoffT = Math.max(0, latestT - windowSizeS);
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
  ], layoutUpdate);

  Plotly.react('plot-charge', [
    { x: [...liveQX], y: [...liveQY], mode: 'lines', name: 'Live Charge' },
    { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded }
  ], {
    ...layoutUpdate,
    yaxis: { title: 'Charge (µAh)', autorange: true }
  });

}, FLUSH_MS);

/* -------------------- MEASUREMENT -------------------- */

function handleMeasurement(batch) {
  // 1. Infinite memory storage for CSV exports and Memory plotting
  for (let i = 0; i < batch.x.length; i++) {
    curRows.push({ t: batch.x[i], current_uA: batch.y[i] });
  }

  // 2. Feed the high-speed rendering buffer
  liveX.push(...batch.x);
  liveY.push(...batch.y);
  liveQX.push(...batch.x);
  liveQY.push(...batch.q);
  
  needsUpdate = true;
}

function resetData() {
  curRows = [];
  liveX.length = liveY.length = 0;
  liveQX.length = liveQY.length = 0;
  
  isViewingMemory = false; // Release memory lock
  needsUpdate = false;

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
     { x: shiftedCsvX(), y: csvY, mode: 'lines', name: 'Log Current', visible: csvLoaded ? true : false }
  ], layoutResetCurrent);

  Plotly.react('plot-charge', [
     { x: [], y: [], mode: 'lines', name: 'Live Charge' },
     { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded ? true : false }
  ], layoutResetCharge);
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
  csvTimeOffset = 0;
  csvOffsetControl.style.display = 'none';   // hide when cleared
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

  csvTimeOffset = 0;                          // reset offset on new file
  csvOffsetInput.value = '0';
  csvOffsetControl.style.display = 'flex';    // show the control
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
  statusEl.textContent = s;

  if (s.startsWith('Connected')) {
    deviceInfoEl.textContent = 'MetaShunt V2 connected';
  }

  if (s === 'Stopped') {
    deviceInfoEl.textContent = 'Not connected';
  }
}

/* -------------------- LOAD FROM MEMORY -------------------- */

plotMemoryBtn.addEventListener('click', () => {
  if (!curRows.length) return alert('No data in memory');

  // Engage lock to stop the 10-second flush loop from overwriting this view
  isViewingMemory = true; 

  const fullX = curRows.map(r => r.t);
  const fullY = curRows.map(r => r.current_uA);

  const fullQX = [];
  const fullQY = [];
  let q = 0;
  let last = null;

  for (let i = 0; i < curRows.length; i++) {
    const r = curRows[i];
    if (last !== null) {
      q += r.current_uA * (r.t - last) / 3600.0;
    }
    last = r.t;
    fullQX.push(r.t);
    fullQY.push(q);
  }

  // Atomic render of the full memory history
  Plotly.react('plot-current', [
    { x: fullX, y: fullY, mode: 'lines', name: 'Live Current' },
    { x: shiftedCsvX(), y: csvY, mode: 'lines', name: 'Log Current', visible: csvLoaded ? true : false }
  ], { 
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', autorange: true }, 
    yaxis: { title: 'Current (µA)', autorange: true } 
  });

  Plotly.react('plot-charge', [
    { x: fullQX, y: fullQY, mode: 'lines', name: 'Live Charge' },
    { x: shiftedCsvQX(), y: csvQY, mode: 'lines', name: 'Log Charge', visible: csvLoaded ? true : false }
  ], { 
    margin: { t: 16 },
    xaxis: { title: 'Time (s)', autorange: true }, 
    yaxis: { title: 'Charge (µAh)', autorange: true } 
  });
});