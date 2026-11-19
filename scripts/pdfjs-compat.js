/* Prepended to both PDF.js bundles by build-chrome-extension.mjs. */
(() => {
  const define = (target, name, value) => {
    if (typeof target[name] === 'function') return;
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      writable: true,
    });
  };

  if (typeof Uint8Array !== 'undefined') {
    define(Uint8Array.prototype, 'toHex', function toHex() {
      let result = '';
      for (let i = 0; i < this.length; i += 1) {
        result += this[i].toString(16).padStart(2, '0');
      }
      return result;
    });

    define(Uint8Array, 'fromBase64', function fromBase64(input, options = {}) {
      let text = String(input).replace(/\s+/g, '');
      if (options.alphabet !== 'base64') {
        text = text.replace(/-/g, '+').replace(/_/g, '/');
      }
      text += '='.repeat((4 - (text.length % 4)) % 4);
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });

    define(Uint8Array.prototype, 'toBase64', function toBase64(options = {}) {
      let result = '';
      for (let i = 0; i < this.length; i += 0x8000) {
        result += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      }
      const encoded = btoa(result);
      return options.alphabet === 'base64url'
        ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
        : encoded;
    });
  }

  define(Math, 'sumPrecise', function sumPrecise(values) {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + Number(value);
      compensation +=
        Math.abs(sum) >= Math.abs(Number(value))
          ? sum - next + Number(value)
          : Number(value) - next + sum;
      sum = next;
    }
    return sum + compensation;
  });

  define(Promise, 'withResolvers', function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  });

  if (typeof Map !== 'undefined') {
    define(Map.prototype, 'getOrInsert', function getOrInsert(key, defaultValue) {
      if (!this.has(key)) this.set(key, defaultValue);
      return this.get(key);
    });
    define(Map.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    });
    define(Map, 'groupBy', function groupBy(values, callback) {
      const result = new Map();
      let index = 0;
      for (const value of values) {
        const key = callback(value, index);
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(value);
        index += 1;
      }
      return result;
    });
  }

  if (typeof WeakMap !== 'undefined') {
    define(WeakMap.prototype, 'getOrInsert', function getOrInsert(key, defaultValue) {
      if (!this.has(key)) this.set(key, defaultValue);
      return this.get(key);
    });
    define(WeakMap.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    });
  }

  if (typeof Object.groupBy !== 'function') {
    define(Object, 'groupBy', function groupBy(values, callback) {
      const result = Object.create(null);
      let index = 0;
      for (const value of values) {
        const key = String(callback(value, index));
        if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = [];
        result[key].push(value);
        index += 1;
      }
      return result;
    });
  }
})();
