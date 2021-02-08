/// Generic utilities concerned with IO and promise management.

import fs from 'fs';
import assert from 'assert';
import process from 'process';
import child_process from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname, basename } from 'path';
import { typename, type, isdef, curry, map, concat, range0 } from 'ferrum';
import { create } from './ferrumpp.js';

const { assign } = Object;
const { mkdir } = fs.promises;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start a coroutine
 * (This is really just calling the function; but using this
 * named function communicates your intent).
 */
export const forkCoro = (fn) => fn();

/**
 * Fork a coroutine for each element from the sequence
 * and wait till they all exit.
 */
export const forkvCoro = (seq, fn) => Promise.all(map(seq, fn));

/**
 * Spawn n coroutines and wait till they all exit
 */
export const forknCoro = (no, fn) => Promise.all(map(range0(no), () => fn()));

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
  static new(...args) {
    return new this(...args);
  }

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
  const { _forking, ...opts } = type(args[args.length - 1]) === Object ? args.pop() : {};
  const proc = child_process[_forking ? 'fork' : 'spawn'](cmd, args, {
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

/** Like spawn, but for the fork() method */
export const fork = (...args) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  return spawn(...args, {
    ...opts,
    stdio: undefined,
    _forking: true,
  });
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
export const waitEvent = curry('waitEvent', (obj, ev) =>
  new Promise((res) => obj.once(ev, (p) => res(p))));

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
  const [ev, r] = await waitAnyEvent(stream, ['open', 'error']);
  if (ev === 'error')
    throw r;
  return stream;
};

/// Like createWriteStream but will reject the promise instead
/// of using the open & error events.
/// Also makes sure the directory for the file is created.
export const openWriteStream = async (path, opts = {}) => {
  const [dir, _] = dirfile(path);
  await mkdir(dir, { recursive: true });
  const stream = fs.createWriteStream(path, opts);
  const [ev, r] = await waitAnyEvent(stream, ['open', 'error']);
  if (ev === 'error')
    throw r;
  return stream;
};

/**
 * First-come-first-serve first-in-first-out async message queue
 *
 * This can be used to turn many complex, async control flows into
 * a much easier to grasp, async event loop; essentially implementing
 * an actor model where async logic is modeled as a group of actors where
 * there are multiple concurrent actors but each single actor is
 * sequential in of itself.
 */
export class BufferedChannel {
  static new() {
    return new this();
  }

  constructor() {
    assign(this, {
      _buffer: [],
      _consumers: [],
    });
  }

  enqueue(ev) {
    if (this._consumers.length > 0)
      this._consumers.shift().resolve(ev);
    else
      this._buffer.push(ev);
  }

  tryDequeue(fallback = null) {
    return this._buffer.length > 0
      ? this._buffer.shift()
      : fallback;
  }

  async dequeue() {
    if (this._buffer.length > 0)
      return this._buffer.shift();

    const b = Barrier.new();
    this._consumers.push(b);
    return (await b); // do not return full barrier
  }
}
