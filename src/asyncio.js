/// Generic utilities concerned with IO and promise management.

import fs from 'fs';
import assert from 'assert';
import process from 'process';
import child_process from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname, basename } from 'path';
import { typename, type, isdef, curry, map, concat } from 'ferrum';
import { create } from './ferrumpp.js';

const { assign } = Object;
const { mkdir } = fs.promises;

const __dirname = dirname(fileURLToPath(import.meta.url));

/// Base class for defining async classes.
/// This disables the use of the constructor & implements the
/// .new() static function which in turn just takes care of object
/// creation and then calls _init() which may be async.
export class AsyncCls {
  static async new(...args) {
    const r = create(this);
    await r._init(...args);
    return r;
  }

  constructor() {
    assert(false, `Use the static new() method to initialize ${typename(type(this))}.`);
  }

  _init() {}
}

/// Like a promise, but has resolve/reject methods
/// and a connect method that can resolve/reject from
/// another promise or barrier.
export class Barrier extends Promise {
  constructor(fn) {
    let props;
    super((_res, _rej) => {
      props = { _res, _rej };
      if (isdef(fn))
        fn(_res, _rej);
    });
    assign(this, props);
  }

  resolve(v) {
    this._res(v);
  }

  reject(e) {
    this._rej(e);
  }

  /// Resolve this barrier with whatever value the given promise
  /// holds or will hold.
  connect(p) {
    p.then(this._res).catch(this._rej);
  }
}

/// Promise that resolves  after the specified number of milliseconds
export const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/// Test if a file is accessible
export const isAccessible = async (path) => {
  try {
    await fs.promises.access(path);
    return true;
  } catch (_) {
    return false;
  }
}

/// Run the given subcommand subcommand
///
/// This differs from child_process.spawn in the following way:
///
/// * stdio defaults to being inherited
/// * arguments are supplied as variadic args
/// * The resulting process object is augmented with a intoPromise()
///   function, which waits for the process to exit ('exit' event)
///   or for some async error to be delivered ('error' event).
///   This is the primary feature of this function, because it means errors
///   and exits will be caught regardless of when you subscribe,
///   so there is no possibility of missing the event being thrown.
/// * The process object itself can also directly be awaited and treated
///   as a promise.
export const spawn = (cmd, ...args /* , opts = {} */) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  const proc = child_process.spawn(cmd, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts,
  });
  proc._onExit = new Promise((res, rej) => {
    proc.on('error', rej);
    proc.on('exit', (code) => res(code));
  }).then((code) => assert.strictEqual(code, 0));
  proc.intoPromise = function() { return this._onExit; };
  proc.catch = function(...args) { return this._onExit.catch(...args) };
  proc.then = function(...args) { return this._onExit.then(...args) };
  proc.finally = function(...args) { return this._onExit.finally(...args) };
  return proc;
};

/// Run a command with the node modules .bin directory in the path,
/// otherwise like `spawn()`
export const npx = (...args) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  const { env = process.env } = opts;
  const { PATH = process.env.PATH } = env;
  return spawn(...args, {
    env: {
      ...env,
      PATH: `${__dirname}/node_modules/.bin/:${PATH}`,
    },
    ...opts,
  });
}

/// Resolve path and decompose into directory/base
/// String -> [String, String]
const dirfile = (path) => {
  const p = resolve(path);
  return [dirname(p), basename(p)];
};

/// Write file; creating the dir if need be
export const writeFile = async (path, cont) => {
  const [dir, _] = dirfile(path);
  await mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path, cont);
};

/// Generate a promise that will resolve as soon as an event is
/// generated
export const waitEvent = curry('waitEvent', (obj, ev) => new Promise((res) => {
  const handler = (param) => {
    obj.removeHandler(handler);
    res(param);
  };
  obj.on(ev, handler);
}));

/// Like promise.race but allows for the promises to be tagged.
/// Seq<[String, Promise<A>]> -> [String, A]
export const taggedRace = (seq) =>
  Promise.race(
    map(seq, ([t, p]) =>
      Promise.resolve(p).then((v) =>
        [t, v])));

/// Combination of taggedRace & waitEvent
export const waitAnyEvent = curry('waitAnyEvent', (obj, evs) =>
  taggedRace(
    map(evs, (ev) =>
      [ev, waitEvent(obj, ev)])))

/// Wait for any given event or the 'error' event.
/// Reject the promise for the error event.
export const waitAnyEventOrErr = curry('waitAnyEventOrErr', (obj, evs) => {
  const [ev, r] = waitAnyEvent(obj, concat(evs, ['error']));
  if (ev === 'error')
    throw r;
  return [ev, r];
});

/// Turn a promise that might reject into a promise that will
/// return a tag and the resulting value or error
/// Promise<V, E> -> Promise<["resolve", V]|["error", E], none>
export const catchingAsync = (p) =>
  Promise.resolve(p)
    .then(v  => ["resolve", v])
    .catch(e => ["error", e]);

/// Like createReadStream but will reject the promise instead
/// of using the open & error events
export const openReadStream = async (path, opts = {}) => {
  const stream = fs.createReadStream(path, opts);
  const [ev, r] = waitAnyEvent(stream, ['open', 'error']);
  if (ev === 'error')
    throw r;
  return stream;
};
