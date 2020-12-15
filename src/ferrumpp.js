/// The sort of functions that might make good extensions to
/// ferrum js. Small, functional programming and closed (meaning
/// decent api). I will probably port some of these to ferrumjs.

import {
  type, curry, pipe, iter, next, list, foldl, map, any, repeat,
  take, each, enumerate, filter, setdefault,
} from 'ferrum';

const { assign } = Object;

// Like assign, but curryable
export const assignProps = curry('assign', (targ, src) =>
    assign(targ, src));

/// Type -> * -> Bool
export const is_a = curry('is_a', (v, t) =>
  type(v) === t);

/// Seq<Type> -> * –> Bool
export const is_any = curry('is_a', (v, tv) =>
  any(map(tv, t => is_a(v, t))));

/// Type A -> A
///
/// Create type bypassing the constructor.
/// Like Object.create, but takes a type instead of a prototype
export const create = (t) => Object.create(t.prototype);

/// fn(Type A, Dict) -> A
///
/// Create type and assign properties, bypassing the constructor
export const createFrom = (t, props) =>
  assign(create(t), props);

/// Seq|List -> List
export const coerce_list = (seq) =>
  is_a(seq, Array) ? seq : list(seq);

/// Seq<V> -> [V, Seq<V>]
export const popl = (seq) => {
  const it = iter(seq);
  const v = next(it);
  return [v, it];
};

/// Seq<V> -> [V, Array<V>]
export const popr = (seq) => {
  const l = list(seq);
  const v = l.pop();
  return [v, l];
};

/// (A -> A -> A) -> Seq<A> -> A
export const foldl1 = curry('foldl1', (seq, fn) => {
  const [v, it] = popl(seq);
  return foldl(it, v, fn);
});

/// Seq<A -> A -> A> -> Seq<A> -> List<A>
export const parallel_foldl1 = (seq, fns_) => {
  const fns = list(enumerate(fns_));
  const [v, it] = popl(seq);
  const state = pipe(repeat(v), take(fns.length), list);
  each(it, (v) => {
    each(fns, ([idx, fn]) => {
      state[idx] = fn(state[idx], v);
    });
  });
  return state;
};

/// fn(Cont, Pairs) => Cont
/// Assign defaults to the given container
export const defaults = (to, from) => {
  each(from, ([k, v]) => setdefault(to, v, k));
  return to;
};

/// Like ferrum filter but applied specifically to the key of key
/// value pairs.
///
/// (* -> IntoBool) -> Sequence<[*, *]> -> Sequence<[*, *]>
export const filterKey = curry('filterKey', (seq, fn) =>
  filter(seq, ([k, _]) => fn(k)));

export const filterValue = curry('filterValue', (seq, fn) =>
  filter(seq, ([_, v]) => fn(v)));

/// Like ferrum map but transforms the key specifically from key/value pairs.
///
/// (A -> B) -> Sequence<[A, C]> -> Sequence<[B, C]>
export const mapKey = curry('mapKey', (seq, fn) =>
  map(seq, ([k, v]) => [fn(k), v]));

/// (A -> B) -> Sequence<[C, A]> -> Sequence<[C, B]>
export const mapValue = curry('mapValue', (seq, fn) =>
  map(seq, ([k, v]) => [k, fn(v)]));

/// Alter some value (using side effects), discard the return
/// value of the mutation function and return the original value.
///
/// (T -> ()) -> T -> T
export const mutating = curry('mutating', (obj, fn) => {
  fn(obj);
  return obj;
});

/// Invoke the given function with the given arguments.
/// [Args...] -> (Args... -> B) -> B
///
/// Mainly useful for currying:
//
/// `each(myFunctions, rapply(['hello world']))`;
export const rapply = curry('rapply', (fn, args) => fn(...args));

/// (() -> ()) -> Bool
/// Determine whether the given function throws
export const throws = (fn) => {
  try {
    fn();
    return false;
  } catch (_) {
    return true;
  }
};

/// Determine if a sequence is empty
export const empty_seq = (seq) => {
  for (const _ of iter(seq)) return false;
  return true;
}

/// Empty function
export const nop = () => {};
