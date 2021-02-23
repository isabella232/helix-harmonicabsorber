import assert from 'assert';
import jstat from 'jstat';
import {
  identity, type, isdef, dict, list, pairs, plus, pipe,
  mapSort, sum, empty, each, map, uniq, deepclone, Deepclone,
  enumerate, filter, curry, range0, size, zip2, ifdef,
} from 'ferrum';

import { TolerantNumber, weightedAverage } from './math.js';
import {
  createFrom, coerce_list, parallel_foldl1, is_a, fnpow,
} from './ferrumpp.js';

const { assign } = Object;
const { ceil, round, min, max, abs, sqrt, } = Math;

/** Naive median implementation */
export const median = (seq) => jstat.median(list(seq));

/**
 * This is the first derivative of the smoothly derivable huber
 * loss approximation suggested by wikipedia.
 */
const smoothHuberLossPsi = (x, k) => x/sqrt(x**2/k**2 + 1);
/**
 * This is δ-|ψ| where δ is the desired cutoff derived from
 * the percentile and ψ is the first derivative of the
 * pseudo huber loss function
 * https://www.desmos.com/calculator/nv9iwh9bwl
 */
const smoothHuberLossWeight = (x, k) => k - abs(smoothHuberLossPsi(x, k));

/**
 * Mean Absolute Deviation -> Standard deviation
 * https://en.wikipedia.org/wiki/Average_absolute_deviation
 */
const meanAD2Stdev = 1/0.79788456;

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

  /**
   * Perform L estimation using the smooth Huber loss weight function
   * on the standard deviation and the mean.
   * https://en.wikipedia.org/wiki/Mean_absolute_difference
   */
  fitLSHL(alpha = 0.05) {
    return this._uncacheNonempty(`fitL_SHL_${alpha}`, (_) => {
      if (size(this.quanta()) === 1)
        return TolerantNumber.new(this.mean(), 0);

      const dat = this.sorted(), len = size(dat);
      const orderFrac = (i) => abs((i-(len-1)/2)*2/(len-1));
      const weights = list(map(range0(len), (i) =>
        smoothHuberLossWeight(orderFrac(i), 1-alpha*2)));

      const center = weightedAverage(zip2(dat, weights));
      const scale =  weightedAverage(zip2(
        map(dat, (x) => abs(x-center)), weights));

      return TolerantNumber.new(center, scale*meanAD2Stdev);
    });
  }

  // This applies an m estimator based on the huber loss function.
  //
  // This should be asymptotically equivalent to windsorization at the
  // α percentile, where is a parameter in [0; 1] indicating the percentile.
  //
  // Returns a tolerant number with the standard deviation of the estimate;
  // this can be used to derive any percentile value to get some user defined
  // confidence interval
  //
  // https://en.wikipedia.org/wiki/Huber_loss#Pseudo-Huber_loss_function
  // https://doi.org/10.1214%2Faoms%2F1177703732
  fitMSHL(alpha = 0.05, iterations = 15) {
    return this._uncacheNonempty(`huber_loss_${alpha}_${iterations}`, (d) => {
      if (empty(d))
        return undefined;

      // This improves upon out guess of the estimator by
      // performing the weighted average again again and again
      // using the previous guess as the center point.
      // The weights are derived from the value of the sample point
      // and the currently assumed distribution instead of the
      // order statistic (this is what differentiates l and m estimators).
      // We should iterate this until it converges
      // (until a fix point is reached).
      // Some heuristic would be nice in math.js that takes some
      // measure of the rate of decent into the fix point to decide
      // whether we should continue…
      // We use the l estimation as the starting point:

      const [c0, s0] = this.fitLSHL(alpha).both();
      const guess = { c: c0, s: s0 };
      const { c, s } = fnpow(guess, guess, ({c, s}) => {
        // Just one element in the sample? Or all the same value?
        // Or close to?
        if (s < 1e-12)
          return {c, s};
        const cutoff = stdev2confidence(s, alpha*2);
        const weights = list(map(d, (x) =>
          smoothHuberLossWeight(x - c, cutoff)));
        const cn = weightedAverage(zip2(d, weights));
        const sn =  weightedAverage(zip2(
          map(d, (x) => abs(x-c)), weights));
        return { c: cn, s: sn };
      });

      return TolerantNumber.new(c, s*meanAD2Stdev);
    });
  }

  /**
   * Like fitMSHL, but returns the confidence interval of the
   * center estimation instead of the scale estimation from the
   * original data.
   */
  fitMSHLCenter(alpha = 0.05, iterations = 15) {
    return ifdef(this.fitMSHL(alpha, iterations), (theta) => {
      const [center, scale] = theta.both();
      // Shamelessly using the central limit theorem for the mean…
      // This is not proper; should look up how to do it for the huber
      // loss function. This will likely be some interpolation between
      // the central limit for the median based on the k value…
      // Or maybe with a bit higher efficiency than either? Unclear.
      const confidence = scale / sqrt(size(this.data()));
      return TolerantNumber.new(center, confidence);
    });
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

  // Median average deviation
  mad() {
    return this._uncacheNonempty('mad', (d) =>
      median(map(d, x => abs(x - this.median()))));
  }

  // https://doi.org/10.2307%2F2291267
  stdevBySn() {
    // in O(n^2); which is slow, but easy to implement
    const cf = 1.1926; // correction factor
    return this._uncacheNonempty('stdevBySn', (d) =>
      cf * median(map(d, (xi) =>
        median(map(d, (xk) =>
          abs(xi-xk))))));
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
    const lfit = this.fitLSHL();
    const mfit = this.fitMSHL();
    const mfitCenter= this.fitMSHLCenter();
    return {
      p90min: this.p90().minimum(),
      p90max: this.p90().maximum(),
      p90range: this.p90().range(),
      p90mean: this.p90().mean(),
      median: this.median(),
      p90stdev: this.p90().stdev(),
      mad: this.mad(),
      stdevBySn: this.stdevBySn(),
      lfitCenter: ifdef(lfit, v => v.mid()),
      lfitStdev: ifdef(lfit, v => v.tolerance()),
      mfitCenter: ifdef(mfit, v => v.mid()),
      mfitStdev: ifdef(mfit, v => v.tolerance()),
      mfitConfidence: ifdef(mfitCenter, v => v.tolerance()),
      p90skewness: this.p90().skewness(),
      p90eccentricity: this.p90().eccentricity(),
      p90discretization: this.p90().discretization(),
      outlandishness: this.outlandishness(),
    };
  }
}

export const stdev2confidence = curry('stdev2confidence', (dev, alpha) =>
  abs(jstat.normal.inv(alpha/2, 0, 1) * dev));

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
    stdev2confidence(dist.tolerance(), alpha));
});
