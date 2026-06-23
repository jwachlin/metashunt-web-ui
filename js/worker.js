import { MetaShuntParser } from './parser.js';

let parser = null;

// Track state for batching and accumulation
let qAccum_uAh = 0;
let lastT = null;

let batchX = [];
let batchY = [];
let batchQ = [];

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
    return;
  }

  if (type === 'chunk') {
    // Process the binary chunk
    parser?.push(new Uint8Array(data));
    
    // The parser just executed synchronously. 
    // Now flush the accumulated batch as a single IPC message.
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