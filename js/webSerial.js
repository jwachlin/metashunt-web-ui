import { MetaShuntParser } from './parser.js';

export class MetaShuntSerial {
  constructor({ useWorker = true } = {}) {
    this.port = null;
    this.reader = null;
    this.running = false;
    this.armed = false;

    // Burst tracking
    this.mode = 'continuous';
    this.expectedBurstSamples = 37000; // TODO, can be up to 37,500 but not working yet
    this.receivedBurst = 0;

    this.onDataCb = () => {};
    this.onStatusCb = () => {};

    this.useWorker = useWorker && !!window.Worker;
    this.worker = null;
    this.parser = null;
  }

  /* -------------------- PUBLIC API -------------------- */

  onData(cb) {
    this.onDataCb = cb;
  }

  onStatus(cb) {
    this.onStatusCb = cb;
  }

  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('WebSerial not supported (use Chrome or Edge)');
    }

    // Get all ports the user has already approved for this site
    const authorizedPorts = await navigator.serial.getPorts();
    
    if (authorizedPorts.length > 0) {
      // TODO filter
      this.port = authorizedPorts[0];
      this.onStatusCb('Found remembered device...');
    } else {
      // Otherwise, we MUST show the picker UI (requires user gesture)
      this.port = await navigator.serial.requestPort();
    }

    // 4. Open the port as usual
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();

    this._initParser();
    this.onStatusCb('Connected');
  }

  /**
   * @param {Object} opts - { mode, burstHz, trigger, triggerUA, stageIndex }
   */
  async start(opts = {}) {
    const {
      mode = 'continuous',
      burstHz = 1000,
      trigger = 'immediate',
      triggerUA = 0,
      stageIndex = 0
    } = opts;

    if (!this.port || !this.reader) throw new Error('Device not connected');

    this.mode = mode;
    this.receivedBurst = 0;

    this.running = true;
    this.armed = false;
    this._readLoop();

    await new Promise(r => setTimeout(r, 300));
    
    // Reset parser/worker state
    if (this.useWorker) {
      this.worker.postMessage({ type: 'reset' });
    } else {
      this.parser.reset();
    }

    this.armed = true;

    if (mode === 'burst') {
      // Construct Burst Command Packet
      let triggerId = 0;
      let triggerLevel = 0;
      
      if (trigger === 'rising') { triggerId = 1; triggerLevel = Math.round((+triggerUA) / 5.0); }
      else if (trigger === 'falling') { triggerId = 2; triggerLevel = Math.round((+triggerUA) / 5.0); }
      else if (trigger === 'stage') { triggerId = 3; triggerLevel = (stageIndex | 0) & 0xFFFF; }
      else if (trigger === 'manual') { triggerId = 4; }

      let rate500 = Math.round(burstHz / 500.0);
      if (rate500 > 255) rate500 = 255;

      const hi = (triggerLevel >> 8) & 0xFF;
      const lo = (triggerLevel & 0xFF);
      const bytes = [0xAA, 0x01, 0x04, rate500, triggerId, hi, lo];
      
      // Checksum calculation
      let chk = 0;
      for (let i = 1; i < bytes.length; i++) chk = (chk + bytes[i]) & 0xFF;
      bytes.push(chk);

      // 3. Send command to hardware
      await this._write(new Uint8Array(bytes));
      
      this.onStatusCb(`Burst requested: ${Math.round(rate500 * 500)} Hz, trigger=${trigger}`);
    }
    else
    {
      this.onStatusCb('Continuous stream started');
    }
  }

  async _write(data) {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  async stop() {
    this.running = false;

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (err) {
        console.warn('Error cancelling reader:', err);
      }
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (err) {
        console.error('Error closing port:', err);
      }
      this.port = null;
    }

    this.reader = null;

    this.onStatusCb('Stopped');
  }

  /* -------------------- INTERNAL -------------------- */

  _initParser() {
    if (this.useWorker) {
      this.worker = new Worker('./js/worker.js', { type: 'module' });

      this.worker.onmessage = e => {
        if (e.data?.type === 'batch') {
          const batch = e.data.data;
          this.onDataCb(batch); // Pass the whole batch to app.js
          
          // Handle Burst Auto-Stop using the length of the batch arrays
          if (this.mode === 'burst') {
            this.receivedBurst += batch.x.length;
            if (this.receivedBurst >= this.expectedBurstSamples) {
              this.onStatusCb(`Burst complete (${this.receivedBurst} samples)`);
              this.stop();
            }
          }
        }
      };

      this.worker.onerror = e => {
        console.error('Worker error:', e);
        this.onStatusCb('Parser worker error');
      };

      this.worker.postMessage({ type: 'init' });
    } else {
      // Fallback for non-worker mode (wraps single points into a batch of 1)
      this.parser = new MetaShuntParser(d => {
         this.onDataCb({ x: [d.t], y: [d.current_uA], q: [0] /* Quick shim */ });
      });
    }
  }

  async _readLoop() {
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done || !value) break;
        if (!this.armed) continue;

        if (this.useWorker) {
          this.worker.postMessage({ type: 'chunk', data: value.buffer }, [value.buffer]);
        } else {
          this.parser.push(value);
        }

        // Burst completion check
        if (this.mode === 'burst') {
          // We count samples here to decide when to stop the UI
          // Note: In worker mode, we rely on the parser emitting events
          // and we should increment receivedBurst in the worker onmessage handler.
        }
      }
    } catch (e) {
      if (this.running) this.onStatusCb(`Error: ${e.message}`);
    } finally {
      if (this.reader) this.reader.releaseLock();
    }
  }
}
