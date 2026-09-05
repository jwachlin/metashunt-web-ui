// Demo stream worker: generates a fake 6 kHz MetaShunt V2 current stream of a
// low-power device with periodic wakeups. Produces batches on a fixed interval
// so 6000 samples/s are produced in real time without flooding IPC.

const FS = 6000;      // samples per second
const DT = 1 / FS;
const BATCH = 240;    // samples per message (40 ms of data)

const PERIOD = 8.1;   // 8s sleep + 40ms + 50ms + 10ms

// Ideal (noise-free) current in µA at a given time t (seconds).
function currentAt(t) {
  const p = ((t % PERIOD) + PERIOD) % PERIOD;
  if (p < 8.0) return 1.5;          // sleep
  if (p < 8.040) return 3200;       // ~3.2 mA settle
  if (p < 8.090) return 100000;     // 100 mA spike
  return 1000;                      // 1 mA tail
}

// Standard normal via Box-Muller.
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let timer = null;
let t = 0;     // demo time, seconds, starts fresh at 0
let q = 0;     // accumulated charge, µAh

function stop() {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

function start() {
  stop();
  t = 0;
  q = 0;
  timer = setInterval(() => {
    const x = new Array(BATCH);
    const y = new Array(BATCH);
    const qArr = new Array(BATCH);
    for (let i = 0; i < BATCH; i++) {
      const level = currentAt(t);
      const noise = gauss() * 0.02 * level;   // ~2% Gaussian noise
      const cur = level + noise;
      q += cur * DT / 3600.0;                 // µAh
      x[i] = t;
      y[i] = cur;
      qArr[i] = q;
      t += DT;
    }
    self.postMessage({ type: 'demo-batch', data: { x, y, q: qArr } });
  }, 40);
}

self.onmessage = (e) => {
  if (e.data?.type === 'start') start();
  else if (e.data?.type === 'stop') stop();
};