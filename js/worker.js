import { MetaShuntParser } from './parser.js';

let parser = null;

self.onmessage = (e) => {
  const { type, data } = e.data;

  if (type === 'init') {
    parser = new MetaShuntParser(measurement => {
      self.postMessage({ type: 'measurement', data: measurement });
    });
    return;
  }

  if (type === 'reset') {
    parser?.reset();
    return;
  }

  if (type === 'chunk') {
    parser?.push(new Uint8Array(data));
  }
};
