/// Everything else & low quality code
import { Buffer } from 'buffer';
import crypto from 'crypto';
import {
  obj, list, type, pairs,
  map, flat,
} from 'ferrum';
import { throws } from './ferrumpp.js';

const { round } = Math;

/// For debug output
export const debug = (...args) => console.error(...args);

/// For debugging inside pipe()
export const debug_seq = (...args) => {
  const x = list(args.pop());
  debug("!!", ...args, x);
  return x;
};

export const backupProps = (o, props) =>
  obj(map(props, k => [k, o[k]]));


/// String -> Bool
/// Determine whether the given string contains a url
export const is_url = (s) => !throws(() => new URL(s));

export const linearizeJson = (v, _prefix = []) =>
  type(v) !== Object && type(v) !== Array ? [_prefix, v] :
    flat(map(pairs(v), ([k, v]) =>
      linearizeJson(v, [..._prefix, k])));

export const millis = n => round(n*1000);

export const roundMillis = n => round(n*1000)/1000;

export const base64 = (s) => Buffer.from(s).toString('base64');

export const catchall = (f) => {
  try {
    return f();
  } catch (_) {
    // pass
  }
}

export const asyncMaskErrors = async (msg, fn) => {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[WARNING] ${msg}:`, e);
  }
}

export const lazy = (fn) => {
  let computed = false, cache = null;
  return () => {
    if (!computed) {
      computed = true;
      cache = fn();
    }
    return cache;
  };
};

export const sha256 = (data) =>
  new crypto.Hash("sha256").update(data).digest("hex");
