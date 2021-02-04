import assert from 'assert';
import jstat from 'jstat';
import {
  identity, type, isdef, dict, list, pairs, plus, pipe,
  mapSort, sum, empty, each, map, uniq, deepclone, Deepclone,
  enumerate, filter, range, curry,
} from 'ferrum';

import { TolerantNumber } from './math.js';
import {
  createFrom, coerce_list, parallel_foldl1, is_a,
} from './ferrumpp.js';

const { assign } = Object;
const { ceil, round, min, max, abs, floor, sqrt, } = Math;

/// Various statistical functions on a population of samples.
export class Samples {
  static new(data) {
    return new Samples(data);
  }

  static coerce(data) {
    return is_a(data, Samples) ? data : Samples.new(data);
  }

  constructor(data) {
    if (is_a(data, Samples)) {
      assign(this, { _cache:  deepclone(data._cache) });
    } else if (is_a(data, Map)) {
      assign(this, { _cache: { points: data } });
    } else {
      assign(this, { _cache: { data: coerce_list(data) } });
    }
  }

  [Deepclone.sym]() {
    return createFrom(type(this), { _cache: deepclone(this._cache) });
  }

  _uncache(prop, fn) {
    if (!isdef(this._cache[prop]))
      this._cache[prop] = fn(this.data());
    return this._cache[prop];
  }

  _uncacheNonempty(prop, fn) {
    return this._uncache(prop, (d) => empty(d) ? undefined : fn(d));
  }

  data() {
    const d = this._cache.data || this._cache.sorted;
    if (isdef(d)) {
      return d;
    } else if (isdef(this._cache.points)) {
      this._cache.data = list(this._cache.points.values());
      return this._cache.data;
    }
  }

  points() {
    return this._uncache('points', (d) => dict(pairs(d)));
  }

  sorted() {
    return this._uncache('sorted', mapSort(identity));
  }

  quanta() {
    return this._uncache('quanta', uniq);
  }

  _stats() {
    if (!isdef(this._cache.sum) && !empty(this.data())) {
      const [a, z, s] = parallel_foldl1(this.data(), [min, max, plus]);
      assign(this._cache, {
        min: a,
        max: z,
        sum: s,
        range: z-a,
        mean: s/this.data().length,
      });
    }
    return this._cache;
  }

  /// Smallest value in the distribution
  minimum() {
    return this._stats().min;
  }

  /// Largest value in the distribution
  maximum() {
    return this._stats().max;
  }

  /// maximum - minimum
  range() {
    return this._stats().range || 0;
  }

  sum() {
    return this._stats().sum;
  }

  mean() {
    return this._stats().mean;
  }

  median() {
    return this._uncacheNonempty('median', jstat.median);
  }

  variance() {
    return this._uncacheNonempty('variance', jstat.variance);
  }

  stdev() {
    return this._uncacheNonempty('stdev', jstat.stdev);
  }

  skewness() {
    return this._uncacheNonempty('skewness', jstat.skewness);
  }

  /** Trim N elements from each end of the distribution */
  trim(n) {
    const len = this.data().length;
    assert(n*2 <= this.data().length,
      `Cannot trim ${n}*2 elements from pupulation of size ${len}`);
    return this._uncache(`trim-${n}`, () => {
      // Store the points in original order
      const m = this.mean();
      const pts = list(map(this.points(), ([x, y]) => ({
        x, y, dev: y-m,
      })));

      // Sort points by deviation on y axis in decreasing order.
      // Use this sort order to assign an *deviation index*; zero
      // being the greatest deviation
      pipe(
        mapSort(pts, ({ dev }) => -dev),
        enumerate,
        each(([idx, rec]) =>
          assign(rec, { idx })));

      // Filter out those entries whose rank is too. This method of
      // trimming is a bit complicated, but it has two advantages:
      // (1) it preserves the original order of the points
      // (2) it produces a result of the expected size even if the population
      // is completely linear (e.g. all values=0)
      return pipe(
        filter(pts, ({idx}) => n <= idx && idx < (len-n)),
        map(({ x, y }) => [x, y]),
        dict,
        type(this).new);
    });
  }

  /**
   * Drop the Nth percentile samples; this always trims the same
   * number of elements from both ends and always favours dropping
   * more elements in case of ambiguity unless this would empty out
   * the sample.
   *
   * E.g. trimming 5%
   *
   * size    trimmed
   * 0       0
   * 1       0
   * 2       0
   * 3       2
   * …       …
   * 40      2
   * 41      4
   *
   * TODO: Using a linearly weighted mean would result in a much smoother
   * behaviour.
   */
  trimPercentile(p) {
    const n = this.data().length;
    const d = ceil(n*p/2);
    return n-2*d <= 0 ? this : this.trim(d);
  }

  /// 90th percentile samples as another Samples type
  p90() {
    return this.trimPercentile(0.05);
  }

  /// Half of the population that is <= mean
  lowerHalf() {
    return this._uncache('lowerHalf', (d) => {
      const l = ceil(d.length / 2);
      const sorted = this.sorted().slice(0, l);
      return createFrom(type(this), { _cache: { sorted }});
    });
  }

  /// Half of the population that is >= mean
  upperHalf() {
    return this._uncache('upperHalf', (d) => {
      const l = ceil(d.length / 2);
      const sorted = this.sorted().slice(-l);
      return createFrom(type(this), { _cache: { sorted }});
    });
  }

  /// This is a measure of how off-center the distribution is;
  /// a distribution with high eccentricity has a lot of data far
  /// from the mean while a low eccentricity distribution has a lot of
  /// data at the mean.
  eccentricity() {
    return this._uncacheNonempty('eccentricity', (d) => {
      // This is essentially the mean squared error of the samples
      // normalized to the standard deviation
      const m = this.mean(), dev = this.stdev();
      return sum(map(d, v => ((v-m)/dev)**2)) / d.length;
    });
  }

  /// A measure of how much outliers are impacting the mean of the distribution
  outlandishness() {
    return this._uncacheNonempty('outlandishness', () =>
      (this.mean() / this.p90().mean())**2);
  }

  /// Measure of how discretized the distribution is
  discretization() {
    return empty(this.data())
      ? undefined
      : this.data().length / this.quanta().size;
  }

  /// Recommend a good bin size for a histogram
  reccomendedBinSize() {
    if (empty(this.data()))
      return 0.1;

    return this._uncacheNonempty('reccomendHistogramBinSize', () => {
      const p90 = this.p90();
      const rec = p90.stdev() * 3.49 * p90.data().length**(-1/13);
      return rec === 0 ? 0.1 : max(rec, 1e-12);
    });
  }

  /**
   * Returns the interval [µ-σ; µ+σ] of the mean distribution according to the central limit theorem.
   */
  meanDistribution() {
    return this.data().length === 0 ? undefined : TolerantNumber.new(
      this.mean(),
      this.stdev() / sqrt(this.data().length));
  }

  /// Assemble a histogram
  histogram(binSize = this.reccomendedBinSize()) {
    const d = this.data();
    const r = new Map();
    each(d, v => {
      const k = round(v/binSize)*binSize;
      r.set(k, (r.get(k) || 0) + 1);
    });
    return createFrom(type(this), { _cache: { points: r }});
  }

  /// Return some key infos about this distribution
  /// (for presenting to a user)
  keyIndicators() {
    const empty = this.data().length === 0;
    return {
      p90min: this.p90().minimum(),
      p90max: this.p90().maximum(),
      p90range: this.p90().range(),
      p90mean: this.p90().mean(),
      p90median: this.p90().median(),
      p90stdev: this.p90().stdev(),
      p90skewness: this.p90().skewness(),
      p90eccentricity: this.p90().eccentricity(),
      p90discretization: this.p90().discretization(),
      outlandishness: this.outlandishness(),
      confidence: empty ? undefined : withConfidence(this.meanDistribution(), 0.05).magnitude(),
      p90confidence: empty ? undefined : withConfidence(this.p90().meanDistribution(), 0.05).magnitude(),
    };
  }
}

/**
 * Given a normal distribution represented as an Interval, calculate
 * a confidence interval.
 *
 * On a more concrete level this allows calculating arbitrary percentile
 * values for a normal distribution from the standard deviation.
 */
export const withConfidence = curry('withConfidence', (dist, alpha) => {
  return TolerantNumber.new(
    dist.mid(),
    abs(jstat.normal.inv(alpha/2, 0, 1) * dist.tolerance()));
});
