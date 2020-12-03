/// Mathematical functions. 

import { curry, pipe } from 'ferrum';
import { foldl1, parallel_foldl1, coerce_list } from './ferrumpp';
const { floor } = Math;
const { isInteger } = Number;

/// * -> Bool
export const isReal = (v) => isFinite(v) && !isInteger(v);

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
