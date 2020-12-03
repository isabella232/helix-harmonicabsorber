import jstat from 'jstat';
import { NewFn, createFrom, coerce_list, } from './ferrumpp';
import { lerpSeq } from './math';
import {
  identity, type, isdef, is_a,
  mapSort, sum, empty, each, map, uniq,
} from 'ferrum';

const { assign } = Object;
const { ceil, round } = Math;

/// Various statistical functions on a population of samples.
export class Samples extends NewFn {
  static corerce(data) {
    return is_a(data, this) ? data : this.new(data);
  }

  constructor(data) {
    super();
    assign(this, {
      _cache: { data: coerce_list(data) }
    });
  }

  _uncache(prop, fn) {
    let p = this._cache[prop];
    if (!isdef(p) && !empty(this.data()))
      p = this._cache[prop] = fn(this.data());
    return p;
  }

  data() {
    return this._cache.data || this._cache.sorted || this._cache.sortedByVariance;
  }

  sorted() {
    return this._uncache('sorted', mapSort(identity));
  }

  sortedByVariance() {
    return this._uncache('sortedByVariance', (d) => {
      const m = this.mean();
      return mapSort(d, (v) => v-m);
    });
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
    return this._stats().range;
  }

  sum() {
    return this._stats().sum;
  }

  mean() {
    return this._stats().mean;
  }

  median() {
    return this._uncache('median', d =>
      lerpSeq(this.sorted(), (d.length-1)/2));
  }

  variance() {
    return this._uncache('variance', jstat.variance);
  }

  stdev() {
    return this._uncache('stdev', jstat.sted);
  }

  skewness() {
    return this._uncache('skewness', jstat.skewness);
  }

  /// 90th percentile samples as another Samples type
  p90() {
    return this._uncache('p90', (d) => {
      const sortedByVariance = this.sortedByVariance().slice(0, ceil(d.length * 0.9));
      return createFrom(type(this), { _cache: { sortedByVariance } });
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
    return this._uncache('eccentricity', (d) => {
      // This is essentially the mean squared error of the samples
      // normalized to the standard deviation
      const m = this.mean(), dev = this.stdev();
      return sum(map(d, v => ((v-m)/dev)**2)) / d.length;
    });
  }

  /// A measure of how much outliers are impacting the mean of the distribution
  outlandishness() {
    return this._uncache('outlandishness', () =>
      (this.mean() / this.p90().mean())**2);
  }

  /// Measure of how discretized the distribution is
  discretization() {
    return this.data().length / this.quanta().size;
  }

  /// Recommend a good bin size for a histogram
  reccomendedBinSize() {
    return this._uncache('reccomendHistogramBinSize', () => {
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
    return r;
  }

  /// Return some key infos about this distribution
  /// (for presenting to a user)
  keyIndicators() {
    return {
      p90min: this.p90().minimum(),
      p90max: this.p90().maxmimum(),
      p90range: this.p90().range(),
      p90mean: this.p90().mean(),
      p90median: this.p90().median(),
      p90stdev: this.p90().stdev(),
      p90skewness: this.p90().skewness(),
      p90excentricity: this.p90().excentricity(),
      p90discretization: this.p90().discretization(),
      outlandishness: this.outlandishness(),
    }
  }
}


