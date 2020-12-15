import { readFile } from 'fs/promises';
import lodash from 'lodash';
import {
  each, empty, map, first, enumerate, pipe,
  dict, values, flat, reject, curry,
  multiline as M
} from 'ferrum';
import { mapValue, is_a } from './ferrumpp.js';
import { Barrier, spawn, writeFile } from './asyncio.js';
import { Samples } from './statistics.js';
import { clamp, maximum } from './math.js';
import { catchall } from './stuff.js';
import { Txt } from './txt.js';

const { assign } = Object;
const { round, max } = Math;
const { camelCase } = lodash;

// Scheduling ---------------------------

class GnuplotSched {
  static new() {
    return new GnuplotSched();
  }

  constructor() {
    assign(this, {
      queue: [],
      procno: 0,
      maxProcs: 8,
      batchSz: 10,
      minBatchSz: 5,
      maxBatchSz: 40,
    });
  }

  enqueue(filename) {
    const r = new Barrier();
    this.queue.push([filename, r]);
    this._tick();
    return r;
  }

  /// Let the scheduler do it's thing
  _tick() {
    if (this.procno >= this.maxProcs)
      return;

    catchall(() => {
      while (!empty(this.queue) && this.procno <= this.maxProcs)
        this._fork(this.queue.splice(0, this.batchSz));

      let growth = 1;
      if (this.procno < this.maxProcs) // Short on jobs
        growth = 0.7;
      else if (!empty(this.queue))
        growth = 1.3;

      this.batchSz = clamp(round(this.batchSz * growth),
        this.minBatchSz, this.maxBatchSz);
    });
  }

  /// Launch an actual gnuplot instance
  async _fork(pairs) {
    if (empty(pairs))
      return;

    try {
      this.procno += 1;
      await spawn('gnuplot', ...map(pairs, first));
    } catch (_) {
      // pass
    }

    try {
      each(pairs, ([_, barrier]) => barrier.resolve());
    } catch (_) {
      // pass
    }

    this.procno -= 1;
    this._tick();
  }
}

const sched = GnuplotSched.new();

/// Execute a gnuplot file
export const plot2svg = async (basename, plot) => {
  const svg = `${basename}.svg`, src = `${basename}.gnuplot`;
  const { width = 640, height = 480, src: code} = plot;

  const preamble = M(`
    reset
    set terminal svg size ${width}, ${height} enhanced background rgb 'white'
    set output ${strlit(svg)}
  `);

  const closing = M(`
    reset
  `);

  await writeFile(src, preamble + '\n\n' + code + '\n\n' + closing);
  await sched.enqueue(src);

  // Enable SVG anti aliasing
  await writeFile(svg,
    (await readFile(svg, 'utf8'))
      .replace(`crispEdges`, `geometricPrecision`));
};

// Plot generators ----------------------------

const ident = (n) => {
  const m = camelCase(String(n));
  return n.match(/^[0-9]/) ? `_${m}` : m;
};

const doll = (n) => `$${ident(n)}`;

const strlit = JSON.stringify;

class Gnuplot extends Txt {
  static new() {
    return new Gnuplot();
  }

  datatable(n, d) {
    return this
      .writeln(`${doll(n)} <<EOF`)
      .write_table(is_a(d, Samples) ? d.points() : d)
      .writeln(`EOF\n`);

  }

  datatables(seq) {
    each(seq, ([k, v]) => this.datatable(k, v));
    return this;
  }

  assemble(opts = {}) {
    return { ...opts, src: this.toString() };
  }
}

const parsePlots = (plots) => pipe(
  mapValue(plots, Samples.coerce),
  reject(([_, s]) => empty(s.data())),
  dict);

const parseMeta = (plots_) => {
  const plots = parsePlots(plots_);
  const meta = plots.size === 1
    ? first(values(plots))
    : Samples.new(flat(map(plots, ([_, v]) => v.data())));
  return { plots, meta };
}

/// Compares one or many series of samples.
/// Data points are linearly interpolated
export const lineWith = curry('lineWith', (plots_, opts) => {
  const { style = 'line', keyopts = 'outside below' } = opts;

  const { plots, meta } = parseMeta(plots_);
  if (empty(meta.data()))
    return { src: "" };

  const off = max(meta.range() * 0.02, 1e-3);
  const src = Gnuplot.new().datatables(plots);

  src.writeln(M(`
    set key ${keyopts}
    set yrange [${meta.minimum()-off}:${meta.maximum()+off}]

  `));

  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} title ${strlit(name)} with ${style}, \\`));

  return src.assemble({
    height: 480 + plots.size*10
  });
});

/// Line plot with default options
export const line = lineWith({});

/// Generate a histogram from one are many data sets
/// One bin size is chosen across all data sets.
export const histogramWith = curry('histogramWith', (plots_, opts) => {
  const { style = 'boxes', keyopts = 'outside below' } = opts;

  const { plots, meta } = parseMeta(plots_);
  if (empty(meta.data()))
    return { src: "" };

  const xmeta = meta.mirrorAxes();
  const binSz = meta.reccomendedBinSize();
  const height = maximum(map(plots, ([_, p]) => p.data().length));
  const src = Gnuplot.new();
  
  src.datatables(mapValue(plots, (p) => p.histogram(binSz)));

  src.writeln(M(`
    set key ${keyopts}
    set boxwidth ${binSz}
    set yrange [0:${height}]
    set style fill transparent solid 0.5 noborder

  `));

  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} title ${strlit(name)} with ${style}, \\`));

  return src.assemble({
    height: 480 + plots.size*10
  });
});

/// Histogram with default opts
export const histogram = histogramWith({});

/// A correlation plot shows many measurement series below
/// each other. Plots are scaled to occupy the full height
/// of the graph frame. This means if two data series are the
/// same except for some scaling factor, they will look exactly
/// the same.
export const correlation = (plots_) => {
  const plots = parsePlots(plots_);
  if (empty(plots))
    return { src: "" };

  const src = Gnuplot.new();

  // This is not a real math graph, we are really using
  // gnuplot as a drawing program here. We use a slot of
  // height one for each data series and leave some margin
  // to place the title (hence the +0.2, *0.7).
  //
  // (We could use the graph coordinate system, but then we
  // would have to apply a scaling factor to all the offsets
  // here based on the number of plots. It's easier to let
  // gnuplot handle this by just scaling our coordinate system)
  //
  // AND we also scale the plot to fill the entire drawing
  // area (hence .minimum() and .range()).
  //
  // We are deactivating the tics, so the relative size used
  // here is of no great concern
  src.datatables(map(enumerate(plots), ([i, [k, p]]) => {
    const m = p.mean();
    const r = p.range() || 0.1;
    const p90r = p.p90().range() || r;
    const scale = 1/p90r * 0.7;
    const yoff = i + 0.5 - m*scale;
    return [k, dict(mapValue(p.points(), v => scale*v + yoff))];
  }));

  src.writeln(M(`
    unset key
    unset tics
    set yrange [0:${plots.size + 0.2}]

  `));

  // labels/plot titles
  each(enumerate(plots), ([i, [k,  _]]) =>
    src.writeln(
      `set label ${strlit(k)} `,
        `at character 4.2, first ${i+1} left front`));

  // Output plots
  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} with line, \\`));

  return src.assemble({ height: 480*0.25*plots.size});
};
