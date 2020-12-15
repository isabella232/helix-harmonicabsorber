import jstat from 'jstat';
import {
  identity, type, isdef, dict, list, pairs, plus, pipe, reverse,
  mapSort, sum, empty, each, map, uniq, deepclone, Deepclone,
  enumerate, filter,
} from 'ferrum';

import {
  createFrom, coerce_list, parallel_foldl1, is_a,
} from './ferrumpp.js';

const { assign } = Object;
const { ceil, round, min, max, abs, } = Math;

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

  /// Swap X and Y axes
  mirrorAxes() {
    return this._uncacheNonempty('mirrorAxes', () => pipe(
      this.points(),
      map(reverse),
      dict,
      type(this).new));
  }

  /// maximum - minimum
  range() {
    return this._stats().range;
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

  /// 90th percentile samples as another Samples type
  p90() {
    return this._uncache('p90', (d) => {
      if (empty(d))
        return type(this).new([]);

      // Store the points in original order
      const m = this.mean();
      const pts = list(map(this.points(), ([x, y]) => ({
        x, y, dev: abs(y-m),
      })));

      // Sort points by deviation on y axis. Use this sort order to
      // assign a percentile rank to each point
      pipe(
        mapSort(pts, ({ dev }) => dev),
        enumerate,
        each(([idx, rec]) =>
          assign(rec, { rank: idx/d.length })));

      // Filter out those entries whose rank is too. This way of
      // gathering a percentile subpopulation is a bit complicated,
      // but it has two advantages: (1) it preserves the original
      // order of the points (2) it produces a result of the expected
      // size even if the population is completely linear (e.g. all values=0)
      return pipe(
        filter(pts, ({rank}) => rank <= 0.9),
        map(({ x, y }) => [x, y]),
        dict,
        type(this).new);
    });
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
      return rec === 0 ? 0.1 : rec;
    });
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
    };
  }
}


