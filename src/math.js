/// Mathematical functions.

import assert from 'assert';
import { curry, foldl, pipe, type, mul, plus } from 'ferrum';
import {
  foldl1, parallel_foldl1, coerce_list, is_a
} from './ferrumpp.js';

const { assign } = Object;
const { floor, round, sqrt, abs } = Math;
const { isInteger } = Number;

/// * -> Bool
export const isReal = (v) => is_a(v, Number) && isFinite(v);

/// Number -> Number -> Number
export const min2 =  curry('min2', Math.min);
export const clamp_upper = min2;

/// Number -> Number -> Number
export const max2 = curry('max2', Math.max);
export const clamp_lower = max2;

/// Number -> Number -> Number -> Number
export const clamp = curry('clamp', (v, a, z) =>
  pipe(v, clamp_lower(a), clamp_upper(z)));

/// Seq<Number> -> Number
export const minimum = (seq) => foldl1(seq, min2);

/// Seq<Number> -> Number
export const maximum = (seq) => foldl1(seq, max2);

/// Seq<Number> -> [Number, Number];
export const minmax = (seq) => parallel_foldl1(seq, [min2, max2]);

/// Number -> Number -> Number
export const lerp = curry('lerp', (a, z, pos) => a + (z-a)*pos);

/// Number -> Sequence<Number> -> Number
export const lerpSeq = curry('lerpSeq', (seq, pos) => {
  const l = coerce_list(seq);
  const idx = floor(pos);
  return isInteger(pos) ? l[pos] : lerpSeq(l[idx], l[idx+1], pos-idx);
});

/* Number -> Number -> Number */
export const roundTo = curry('roundTo', (v, unit) => round(v/unit)*unit);

/**
 * Represents a number a±b; that is a number in the interval [a-b; a+b].
 *
 * Implements the rules from https://en.wikipedia.org/wiki/Propagation_of_uncertainty
 * We could use https://aif.bit.uni-bonn.de/jz/algebraic_uncertainty_theory.pdf for a more sophisticated (and possibly verified) treatment.
 *
 * All calculations assume uncorrelated variables.
 */
export class TolerantNumber {
  static cast(no) {
    return no instanceof this ? no : this.new(no, 0);
  }

  static fromInterval(lower, upper) {
    const mid = (lower+upper)/2;
    return this.new(mid, mid-lower);
  }

  static new(...args) {
    return new this(...args);
  }

  constructor(no, tolerance) {
    assign(this, { _no: no, _tolerance: abs(tolerance) });
  }

  val() {
    return this._no;
  }

  tolerance() {
    return this._tolerance;
  }

  /** Returns [val(), tolerance()] */
  both() {
    return [this.val(), this.tolerance()];
  }

  lower() {
    return this.mid() - this.tolerance();
  }

  mid() {
    return this.val();
  }

  upper() {
    return this.mid() + this.tolerance();
  }

  /** tolerance()*2 */
  magnitude() {
    return this.tolerance()*2;
  }

  /** Returns [lower(), upper()] */
  interval() {
    return [this.lower(), this.upper()];
  }

  /** Returns [lower(), mid(), upper()] */
  midInterval() {
    return [this.lower(), this.mid(), this.upper()];
  }

  /**
   * Application of an arbitrary scalar function.
   */
  applyScalar(fn) {
    return type(this).fromInterval(
      fn(this.lower()), fn(this.upper()));
  }

  /**
   * Combine with another Number or TolerantNumber.
   */
  _combine(otr, fn, toleranceFn) {
    if (!(otr instanceof TolerantNumber))
      return this.applyScalar(v => fn(v, otr));
    const [[a, ta], [b, tb]] = [this.both(), otr.both()];
    const r = fn(a, b);
    const tr = toleranceFn(r, a, ta, b, tb);
    return type(this).new(r, tr);
  }

  mul(otr) {
    return this._combine(otr, mul, (r, a, ta, b, tb) =>
      abs(r) * sqrt( (ta/a)**2 + (tb/b)**2));
  }

  add(otr) {
    return this._combine(otr, plus, (_r, _a, ta, _b, tb) =>
      sqrt(ta**2 + tb**2));
  }
}

/* A: Number|TolerantNumber, Seq<[A, Number]> -> A */
export const weightedAverage = (seq) => {
  const [v, w] = foldl(seq, [0, 0], ([va, wa], [v, w]) => {
    const tolerant = va instanceof TolerantNumber || v instanceof TolerantNumber;
    const vr = tolerant ? TolerantNumber.cast(v).mul(w).add(va) : va+(v*w);
    return [vr, wa+w];
  });
  assert(w !== 0, 'Cannot calculate mean of empty population!');
  return v instanceof TolerantNumber ? v.mul(1/w) : v/w;
};

