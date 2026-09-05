import { MetaShuntParser } from './parser.js';

let parser = null;

// Track state for batching and accumulation
let qAccum_uAh = 0;
let lastT = null;

let batchX = [];
let batchY = [];
let batchQ = [];

// Diagnostics: raw bytes delivered vs frames accepted.
let rxBytes = 0;
let acceptedFrames = 0;
let statsWindowAt = 0;
const STATS_WINDOW = 3000;

function maybePostWindowStats(now) {
  if (now - statsWindowAt < STATS_WINDOW) return;
  self.postMessage({
    type: 'window-stats',
    data: { rxBytes, acceptedFrames, ms: now - statsWindowAt }
  });
  rxBytes = 0;
  acceptedFrames = 0;
  statsWindowAt = now;
}

self.onmessage = (e) => {
  const { type, data } = e.data;

  if (type === 'init') {
    parser = new MetaShuntParser(measurement => {
      const { t, current_uA } = measurement;
      
      // Calculate charge in the worker to save main thread CPU
      if (lastT !== null) {
        const dt = t - lastT;
        qAccum_uAh += current_uA * dt / 3600.0;
      }
      lastT = t;

      batchX.push(t);
      batchY.push(current_uA);
      batchQ.push(qAccum_uAh);
      acceptedFrames++;
      maybePostWindowStats(performance.now());
    }, {
      logStatsEveryMs: 3000,
      onStats: (s) => self.postMessage({ type: 'parser-stats', data: s })
    });
    return;
  }

  if (type === 'reset') {
    parser?.reset();
    qAccum_uAh = 0;
    lastT = null;
    batchX.length = 0;
    batchY.length = 0;
    batchQ.length = 0;
    rxBytes = 0;
    acceptedFrames = 0;
    statsWindowAt = 0;
    return;
  }

  if (type === 'chunk') {
    // Process the binary chunk
    if (parser) {
      rxBytes += new Uint8Array(data).byteLength;
      parser.push(new Uint8Array(data));
      maybePostWindowStats(performance.now());
    } else {
      console.warn('[worker] chunk received before parser init');
    }
    
    // Include running accepted-frame count so main thread can compare bytes vs frames.
    if (batchX.length > 0) {
      self.postMessage({ 
        type: 'batch', 
        data: { x: batchX, y: batchY, q: batchQ } 
      });
      
      batchX = [];
      batchY = [];
      batchQ = [];
    }
  }
};