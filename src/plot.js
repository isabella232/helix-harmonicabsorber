import { readFile, rm } from 'fs/promises';
import lodash from 'lodash';
import Svgo from 'svgo';
import {
  each, empty, map, first, enumerate, pipe,
  dict, values, flat, reject, curry,
  multiline as M,
  type, Deepclone, obj, deepclone, join, filter, isdef,
} from 'ferrum';
import { mapValue, is_a, createFrom, nop } from './ferrumpp.js';
import { Barrier, sleep, spawn, writeFile } from './asyncio.js';
import { Samples } from './statistics.js';
import { clamp, maximum } from './math.js';
import { catchall, debug } from './stuff.js';
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

  enqueue(file, opts = {}) {
    const { post = nop, output } = opts;
    const barrier = new Barrier();
    this.queue.push({file, barrier, post, output});
    this._tick();
    return barrier;
  }

  /// Let the scheduler do it's thing
  _tick() {
    if (this.procno >= this.maxProcs)
      return;

    while (!empty(this.queue) && this.procno <= this.maxProcs)
      this._fork(this.queue.splice(0, this.batchSz));

    let growth = 1;
    if (this.procno < this.maxProcs) // Short on jobs
      growth = 0.7;
    else if (!empty(this.queue))
      growth = 1.3;

    this.batchSz = clamp(round(this.batchSz * growth),
      this.minBatchSz, this.maxBatchSz);
  }

  /// Launch an actual gnuplot instance
  async _fork(jobs) {
    if (empty(jobs))
      return;

    try {
      this.procno += 1;

      // Remove the file so post processing can pick up on it
      // if gnuplot entirely neglected to process the file
      await Promise.all(pipe(
        filter(jobs, ({ output }) => isdef(output)),
        map(({ output }) => rm(output, { force: true }))));
      // Run gnuplot
      await spawn('gnuplot', ...map(jobs, ({ file }) => file));
      // Run post processing (e.g. load the generated file and
      // validate it or optimize it to pick up on gnuplot messing up)
      await Promise.all(map(jobs, async (job) => {
        job.postResult = await job.post();
      }));
    } catch (e) {
      // Gnuplot tends to fail the entire bunch when there is just
      // a single bad file. This error handler performs error isolation
      // by splitting each batch. This will ultimately find the specific
      // broken files (and compile all others) in O(log(n)). This if
      // statement is the termination condition
      if (jobs.length === 1) {
        const [{ barrier }] = jobs;
        barrier.reject(e);
        return;
      }

      debug(`[WARNING] Gnuplot failed with:`, e,
        `\n    On the following files:`
          + join('')(
            map(jobs, ({ file }) => `\n        ${file}`)));

      // Split the batch and retry
      const sub = [
        jobs.splice(0, round(jobs.length/2)),
        jobs];
      await Promise.all(map(sub, (set) => this._fork(set)));

      return;
    } finally {
      // This always runs (even if catch returns)
      this.procno -= 1;
      this._tick();
    }

    // This runs only of the try block is successfully;
    // it is not part of the block because this could
    // lead the barriers being resolves repeatedly if
    // resolve() itself throws (unlikely)
    each(jobs, ({ barrier, postResult }) =>
      barrier.resolve(postResult));
  }
}

const sched = GnuplotSched.new();

// Plot generators ----------------------------

const ident = (n) => {
  const m = camelCase(String(n));
  return n.match(/^[0-9]/) ? `_${m}` : m;
};

const doll = (n) => `$${ident(n)}`;

const strlit = JSON.stringify;

const svgo = new Svgo();

class Gnuplot {
  static new(opts) {
    return new Gnuplot(opts);
  }

  constructor(opts = {}) {
    const { width = 640, height = 480 } = opts;
    assign(this, {
      parameters: { width, height, },

      data: Txt.new(),
      settings: Txt.new(),
      plots: Txt.new(),

      _pointCtr: 0,
    });
  }

  [Deepclone.sym]() {
    const fields = [
      'parameters', 'data', 'settings', 'plots', '_pointCtr'
    ];
    return createFrom(type(this), obj(
      map(fields, (name) => [name,
        deepclone(this[name])])));
  }

  datatable(n, d) {
    const dat = pipe(
      is_a(d, Samples) ? d.points() : d,
      map(v => {
        this._pointCtr += 1;
        return v;
      }));

    return this.data
      .writeln(`${doll(n)} <<EOF`)
      .write_table(dat)
      .writeln(`EOF\n`);

  }

  datatables(seq) {
    each(seq, ([k, v]) => this.datatable(k, v));
    return this;
  }

  isEmpty() {
    return this._pointCtr <= 0 || Boolean(
      this.plots.toString().match(/^\s*$/));
  }

  toString() {
    const out = Txt.new()
      .writeln(`reset`)
      .writeln()
      .write(this.data)
      .writeln(this.settings)
      .writeln();

    if (!this.isEmpty()) {
      out.writeln(
        `plot ` + pipe(
          this.plots.toString().split('\n'),
          reject((s) => s.match(/^\s*$/)), // empty lines
          join(`, \\\n     `)));
    }

    return out.writeln(`\nreset`).toString();
  }

  async writeSvg(basename) {
    const { width, height } = this.parameters;
    const svg = `${basename}.svg`, src = `${basename}.gnuplot`;
    const code = deepclone(this);

    code.settings.write(M(`
      set terminal svg size ${width}, ${height} enhanced background rgb 'white'
      set output ${strlit(svg)}
    `));

    await writeFile(src, code.toString());

    await sched.enqueue(src, async () => {
      const generated = await readFile(svg, 'utf8')

      // Enable SVG anti aliasing and run the svg optimizer
      // (primarily to check whether the svg is well formed)
      const { data: optimized } = await svgo.optimize(
        generated.replace(`crispEdges`, `geometricPrecision`));

      await writeFile(svg, optimized);
    });
  }
}


const parse = (plots_) => {
  const plots =  pipe(
    mapValue(plots_, Samples.coerce),
    reject(([_, s]) => empty(s.data())),
    dict);
  const meta = plots.size === 1
    ? first(values(plots))
    : Samples.new(flat(map(plots, ([_, v]) => v.data())));
  const xmeta = pipe(
    map(plots, ([_name, p]) => p.points()),
    flat,
    map(([x, _y]) => x),
    enumerate,
    dict,
    Samples.new);
  return { plots, meta, xmeta };
}

const addmarkings = (src, opts = {}) => {
  const { xmarkings = [], ymarkings = [] } = opts;

  each(enumerate(ymarkings), ([idx, [name, no]]) =>
    src.plots.writeln(`${no} title ${strlit(name)}`));

  each(enumerate(xmarkings), ([idx, [name, no]]) => {
    if (idx === 0)
      src.settings.writeln(`\nset parametric`);
    src.plots.writeln(`${no},t title ${strlit(name)}`);
  });
};

/// Compares one or many series of samples.
/// Data points are linearly interpolated
export const lineWith = curry('lineWith', (plots_, opts) => {
  const {
    style = 'line',
    keyopts = 'outside below',
    logx, logy,
    xmarkings, ymarkings,
  } = opts;

  const { plots, meta, xmeta } = parse(plots_);
  if (meta.data().length === 0)
    return Gnuplot.new();

  const off = max(meta.range() * 0.02, 1e-3);
  const height = 480 + plots.size*20;
  const xoff = xmeta.range() === 0 ? 0.01 : 0;
  const src = Gnuplot.new({ height }).datatables(plots);

  const {
    xmin = xmeta.minimum()-xoff,
    xmax = xmeta.maximum()+xoff,
    ymin = meta.minimum()-off,
    ymax = meta.maximum()+off,
  } = opts;

  src.settings.writeln(M(`
    set key ${keyopts}
    set xrange [${xmin}:${xmax}]
    set yrange [${ymin}:${ymax}]
    set trange [${ymin}:${ymax}]
  `));

  if (logx)
    src.settings.writeln(`set logscale x ${logx}`);
  if (logy)
    src.settings.writeln(`set logscale y ${logy}`);

  each(plots, ([name, _]) =>
    src.plots.writeln(
      `${doll(name)} title ${strlit(name)} with ${style}`));

  addmarkings(src, { xmarkings, ymarkings });

  return src;
});

/// Line plot with default options
export const line = lineWith({});

/// Generate a histogram from one are many data sets
/// One bin size is chosen across all data sets.
export const histogramWith = curry('histogramWith', (plots_, opts) => {
  const {
    style = 'boxes', keyopts = 'outside below',
    xmarkings, ymarkings,
  } = opts;

  const { plots, meta, xmeta } = parse(plots_);
  if (meta.data().length === 0)
    return Gnuplot.new();

  const ymin = 0;
  const ymax = maximum(map(plots, ([_, p]) => p.data().length));
  const binSz = meta.reccomendedBinSize();
  const xoff = meta.range() === 0 ? 0.01 : 0;

  const src = Gnuplot.new({
    height: 480 + plots.size*10
  });
  
  src.datatables(mapValue(plots, (p) => p.histogram(binSz)));
  src.settings.writeln(M(`
    set key ${keyopts}
    set boxwidth ${binSz}
    set xrange [${meta.minimum()-xoff}:${meta.maximum()+xoff}]
    set yrange [${ymin}:${ymax}]
    set trange [${ymin}:${ymax}]
    set style fill transparent solid 0.5 noborder
  `));

  each(plots, ([name, _]) =>
    src.plots.writeln(`${doll(name)} title ${strlit(name)} with ${style}`));

  addmarkings(src, { xmarkings, ymarkings });

  return src;
});

/// Histogram with default opts
export const histogram = histogramWith({});

/// A correlation plot shows many measurement series below
/// each other. Plots are scaled to occupy the full height
/// of the graph frame. This means if two data series are the
/// same except for some scaling factor, they will look exactly
/// the same.
export const correlation = (plots_) => {
  const { plots, meta, xmeta } = parse(plots_);
  if (meta.data().length === 0)
    return Gnuplot.new();

  const xoff = xmeta.range() === 0 ? 0.01 : 0;
  const src = Gnuplot.new({ height: 480*0.25*plots.size });

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

  src.settings.writeln(M(`
    unset key
    unset tics
    set xrange [${xmeta.minimum()+xoff}:${xmeta.maximum()+xoff}]
    set yrange [0:${plots.size + 0.2}]

  `));

  // labels/plot titles
  each(enumerate(plots), ([i, [k,  _]]) =>
    src.settings.writeln(
      `set label ${strlit(k)} `,
        `at character 4.2, first ${i+1} left front`));

  // Output plots
  each(plots, ([name, _]) =>
    src.plots.writeln(`${doll(name)} with line`));

  return src;
};
