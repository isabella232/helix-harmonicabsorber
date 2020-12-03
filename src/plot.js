import { readFile } from 'fs/promises';
import { camelCase } from 'lodash';
import {
  each, empty, map, first, enumerate, isdef, filter, pipe,
  multiline as M
} from 'ferrum';
import { NewFn, mapValue, is_a } from './ferrumpp';
import { Barrier, spawn, writeFile } from './asyncio';
import { Samples } from './statistics';
import { clamp, maximum } from './math';
import { catchall } from './stuff';
import { Txt } from './txt';

const { assign } = Object;
const { round, max } = Math;

// Scheduling ---------------------------

class GnuplotSched extends NewFn {
  constructor() {
    super();
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
    this.initShed();
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
      await spawn('gnuplot', ...map(pairs, first)).onExit;
    } catch (_) {
      // pass
    }

    try {
      each(pairs, ([_, barrier]) => barrier.resolve());
    } catch (_) {
      // pass
    }

    this.procno -= 1;
    this.sched();
  }
}

const sched = GnuplotSched.new();

/// Execute a gnuplot file
export const plot2svg = async (basename, plot) => {
  const svg = `${basename}.svg`, src = `${basename}.gnuplot`;
  const { width = 640, height = 480, src: code} = plot;

  await writeFile(src, M(`
    set terminal svg size ${height}, ${width}
    set output ${strlit(svg)}

    ${code}
  `));
  await sched.enqueue(src);

  // Enable SVG anti aliasing
  await writeFile(svg,
    (await readFile(svg, 'utf8'))
      .replace(`crispEdges`, `geometricPrecision`));
};

// Plot generators ----------------------------

const ident = (n) => {
  const m = camelCase(String(name));
  return n.match(/^[0-9]/) ? `_${m}` : m;
};

const doll = (n) => `$${ident(n)}`;

const strlit = JSON.stringify;

class Gnuplot extends Txt {
  doll(n) {
    return this.write(`$${ident(n)}`);
  }

  datatable(n, d) {
    return this
      .writeln(`${doll(n)} <<EOF`)
      .write_table(d)
      .writeln(`EOF\n`);

  }

  datatables(seq) {
    each(seq, ([k, v]) => this.datatable(k, v));
  }

  datalist(n, d) {
    return this.datatable(n, pipe(
      is_a(d, Samples) ? d.data() : d,
      enumerate,
      filter(([_, v]) => isdef(v))
    ));
  }

  datalists(seq) {
    each(seq, ([k, v]) => this.datalist(k, v));
  }

  assemble(opts = {}) {
    return { ...opts, src: this.toString() };
  }
}

const parsePlots = (plots) =>
  dict(mapValue(plots, Samples.coerce));

const parseMeta = (plots_) => {
  const plots = parsePlots(plots_);
  const meta = plots.size === 1
    ? first(values(plots))
    : Samples.new(flat(mapValue(plots, v => v.data)));
  return { plots, meta };
}

/// Compares one or many series of samples.
/// Data points are linearly interpolated
export const line = (plots_) => {
  const { plots, meta } = parseMeta(plots_);
  const off = max(meta.range() * 0.02, 1e-3);
  const src = Gnuplot.new().datalists(plots);

  src.writeln(M(`

    set key outside below
    set yrange [${meta.minimum()-off}:${meta.maximum()+off}]

  `));

  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} title ${strlit(name)} with line, \\`));

  return src.assemble();
};

/// Generate a histogram from one are many data sets
/// One bin size is chosen across all data sets.
export const histogram = (plots_) => {
  const { plots, meta } = parseMeta(plots_);
  const binSz = meta.reccomendedBinSize();
  const height = maximum(map(plots, p => p.data().length));
  const src = Gnuplot.new();
  
  src.datatables(mapValue(plots, ([n, p]) =>
    [n, p.histogram(binSz)]));

  src.writeln(M(`

    set key outside below
    set yrange [0:${height}]
    set style fill transparent solid 0.5 noborder

  `));

  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} title ${strlit(name)} with boxes, \\`));

  return src.assemble();
};

/// A correlation plot shows many measurement series below
/// each other. Plots are scaled to occupy the full height
/// of the graph frame. This means if two data series are the
/// same except for some scaling factor, they will look exactly
/// the same.
export const correlation = (plots_) => {
  const plots = parsePlots(plots_);
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
  src.datalists(map(enumerate(plots), ([i, [k, p]]) => {
    const a = 1/p.range() * 0.7;
    const b = -p.minimum() + i + 0.2;
    return [k, map(p, x => a*x + b)];
  }));

  src.writeln(M(`

    unset key
    set yrange [0:${plots.size + 0.2}]

  `));

  // labels/plot titles
  each(enumerate(plots), ([i, [k,  _]]) =>
    src.writeln(
      `set label ${strlit(k)} `,
        `at character 0.8, first ${i} left front`));

  // Output plots
  src.writeln(`plot \\`);
  each(plots, ([name, _]) =>
    src.writeln(`  ${doll(name)} with line, \\`));

  return src.assemble({ height: 480*0.25*plots.size});
};
