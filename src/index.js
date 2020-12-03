import fs from 'fs';
import process from 'process';
import minimist from 'minimist';
import glob from 'fast-glob';
import yaml from 'yaml';
import marked from 'marked';

import { dirname } from 'path';
import { v4 as uuidgen } from 'uuid';
import {isPlainObject, camelCase} from 'lodash';
import {
  isdef, exec, type,
  setdefault, obj, dict,
  map, range, filter, each,
  mapSort, list, pipe,
  chunkify, values, first, uniq, enumerate, flat, concat, second, empty,
  append, pairs,
} from "ferrum";

const { rmdirSync, createReadStream, createWriteStream } = fs;
const { mkdir, readFile } = fs.promises;

/// Create the mock certificate authority used to intercept ssl traffic
const makeca = async () => {
  await exe('openssl', 'genrsa',
    '-out', cakey, '4096').onExit;
  await exe('openssl', 'req', '-x509', '-new', '-nodes',
    '-key', cakey,
    '-out', cacert,
    '-days', '10',
    '-subj', '/C=US/ST=Utah/L=Provo/O=DO NOT TRUST Helix Dummy Signing Authority DO NOT TRUST/CN=project-helix.io').onExit;
};

const report = async (dir, outdir) => {
  await mkdir(outdir, { recursive: true });

  const experiments = pipe(
    await Promise.all(pipe(
      // List dirs which contain at least one */report.json
      await glob('*/*/report.json', { cwd: dir }),
      map(f => f.split('/')[0]),
      uniq,
      // Parse name & analyze dir
      map(async d => {
        const [_, _no, name] = d.match(/^(.*?)-(.*)$/);
        return [name, await analyze(`${dir}/${d}`)]
      }))),
    // Sort name by number
    mapSort(first),
    dict);

  const metrics = pipe(
    experiments,
    map(([_, ex]) => keys(ex.metrics)),
    flat,
    uniq,
  );

  const forks = [];
  const fork = (...args) => each(args, v => forks.push(v));

  // const combos = [
  //   ['empty', 'simulator', 'online', 'simulator+statified'],
  //   ['simulator', 'simulator+david', 'pages', 'pages+david'],
  //   ['simulator+statified', 'simulator+statified+david'],
  //   ['simulator', 'simulator+cached'],
  //   ['simulator+cached', 'simulator+cached+nointeractive', 'simulator+cached+noexternal'],
  //   ['simulator+cached+noexternal', 'simulator+cached+noexternal+nocss', 'simulator+cached+noexternal+nocss+nojs'],
  // ];

  const combos = [
    ['empty',        'pages', 'pages+cached'],
    ['pages+cached', 'pages+cached+nointeractive', 'pages+cached+noadtech', 'pages+cached+noexternal'],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nofonts',  'pages+cached+noexternal+nocss'],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nosvg', 'pages+cached+noexternal+noimg',],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nojs'],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nofonts+nosvg+noimg'],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nofonts+nosvg+noimg+nocss'],
    ['pages+cached+noexternal', 'pages+cached+noexternal+nofonts+nosvg+noimg+nocss+nojs'],
  ];

  class ReportFile extends TextFile {
    constructor(...args) {
      super(...args);
    }

    dir() {
      return dirname(this.file);
    }

    plot(name, alt, gnuplotBuilder, ...args) {
      fork(gnuplotBuilder.plot(`${this.dir()}/${name}`, ...args));
      this.writeln(`![${alt}](./${name}.png)  `)
    }

    end() {
      this.writeln(`
<style>
  img {
    max-width: 80%;
  }
</style>
      `);

      const s = this.buf.join('');
      fork(writeFile(
        this.file.replace(/readme\.md$/, 'index.html'),
        marked(s)));

      this.buf = [s];
      fork(super.end());
    }
  };

  const reportSingleMetric = (name, dir, scoreAna, rawAna) => {
    let r = new ReportFile(`${dir}/readme.md`);

    r.writeln(`# Report ${name}\n`);
    r.writeln(`[parent..](./..)  \n`);

    r.writeln(`\n## Scores\n`)
    r.plot("score", "score",
      new Gnuplot()
        .data(scoreAna.val || [], name, { with: 'line' })
        .normalizeYrange());

    r.writeln(`\n## Score Histogram\n`)
    let [hist, histWidth] = histogram(scoreAna.val || [])
    r.plot("hist", "hist",
      new Gnuplot()
        .table(hist, name, { with: 'boxes' })
        .normalizeYrange({ a: 0, off: 0 })
        .instruct(`set boxwidth ${histWidth}`)
        .instruct(`set style fill transparent solid 0.5 noborder`));

    r.writeln(`\n## Score Indicators\n`)
    {
      const { val, ...rest } = scoreAna;
      r.writeln('```yaml');
      r.writeln(yaml.stringify(rest));
      r.writeln('```');
    }

    r.writeln(`\n## Raw Values\n`);

    r.plot("raw", "raw",
      new Gnuplot()
        .data(rawAna.val || [], `raw ${name}`, { with: 'line' })
        .normalizeYrange());

    r.writeln(`\n## Raw Values Histogram\n`);
    ([hist, histWidth] = histogram(rawAna.val));
    r.plot("raw_hist", "raw hist",
      new Gnuplot()
        .table(hist, name, { with: 'boxes' })
        .normalizeYrange({ a: 0, off: 0 })
        .instruct(`set boxwidth ${histWidth}`)
        .instruct(`set style fill transparent solid 0.5 noborder`));

    r.writeln(`\n## Raw Indicators\n`)

    {
      const { val, ...rest } = rawAna;
      r.writeln('```yaml');
      r.writeln(yaml.stringify(rest));
      r.writeln('```');
    }

    r.end();
  };

  const reportMetricGroup = (name, getScoreAnalysis, getRawAnalysis) => {
    let r = new ReportFile(`${outdir}/${name}/readme.md`);

    r.writeln(`# Report ${name}\n`);

    r.writeln(`[parent..](./..)  \n`);
    each(experiments, ([title, _]) =>
      r.writeln(`[${title}](./${title}/)  `));

    r.writeln('\n## Indicator Progression\n');

    const indiCombos = [
      ["score:mean", "score:median"],
      ["mean", "median"],
      ["min", "max"],
      ["range", "p90range"],
      ["stddev", "p90stddev", "skewness"],
      ["eccentricity", "p90eccentricity"],
      ["quanta", "p90quanta"],
      ["quantaRatio", "p90quantaRatio"],
      ["outlandishness"],
    ];

    const progression = [
      'pages',
      'pages+cached',
      'pages+cached+noadtech',
      'pages+cached+noexternal',
      // 'pages+cached+noexternal+nofonts',
      // 'pages+cached+noexternal+svg',
      // 'pages+cached+noexternal+noimg',
      // 'pages+cached+noexternal+nocss',
      'pages+cached+noexternal+nofonts+nosvg+noimg',
      'pages+cached+noexternal+nofonts+nosvg+noimg+nocss',
      'pages+cached+noexternal+nofonts+nosvg+noimg+nocss+nojs'
    ];

    each(enumerate(progression), ([idx, name]) => {
      r.writeln(`${idx+1}. ${name}\n`);
    });
    r.writeln(`\n`);

    const indicators = pipe(
      indiCombos,
      flat,
      uniq,
      map(n => [n, []]),
      obj);

    each(progression, (expName) => {
      const exp = experiments.get(expName);
      const raw = getRawAnalysis(exp) || {};
      const score = getScoreAnalysis(exp) || {};
      const ana = { score, raw };

      each(indicators, ([indi, vals]) => {
        const [src, name] = indi.match(/:/) ? indi.split(':') : ['raw', indi];
        vals.push(ana[src][name]);
      });
    });

    each(indiCombos, (combo) => {
      const plot = new Gnuplot();
      each(combo, indi =>
        plot.data(indicators[indi], indi, { with: 'line' }));
      plot.normalizeYrange();
      r.plot(["progession", ...combo].join('_'), '', plot);
    });

    // Display comparisons

    r.writeln('\n## Raw Comparison\n');

    each(combos, combo => {
      const plotName = [name, ...combo].join('_');
      const plot = new Gnuplot();
      const hist = new Gnuplot();
      let hw = 1;
      each(combo, title => {
        const analysis = getRawAnalysis(experiments.get(title));
        const values = (analysis || {}).val || [];
        plot.data(values, title, { with: 'line' });
        let h = histogram(values);
        hist.table(h[0], title, { with: 'boxes' });
        hw = min(hw, h[1]);
      });
      plot.normalizeYrange();
      const histAllX = pipe(
        map(hist.datasets, ({data}) => data),
        flat,
        map(first),
        list,
      );
      hist.instruct(`set boxwidth ${max(hw, jstat.range(histAllX)/50)}`);
      hist.instruct(`set style fill transparent solid 0.5 noborder`);
      hist.normalizeYrange({ a: 0, off: 0 });
      r.plot(plotName, plotName, plot);
      r.plot(plotName + "+hist", plotName + " Histogram", hist);
    });

    // Report on each component

    each(experiments, ([title, experiment]) => {
      reportSingleMetric(title, `${outdir}/${name}/${title}/`,
        getScoreAnalysis(experiment) || {},
        getRawAnalysis(experiment) || {});
    });

    r.end();
  };

  const reportExperiment = (name, dir, ex) => {
    let r = new ReportFile(`${dir}/readme.md`);

    r.writeln(`# Report ${name}\n`);

    r.writeln(`[parent..](./..)  \n`);

    const plots = pipe(
      ex.metrics,
      map(([name, struct]) => [name, (struct.score || {})]),
      filter(([_, v]) => !empty((v || {}).val || [])),
      mapSort(([_, v]) => stdev(percdev(v.val, 0.9))),
      append(['overall score', ex.perf]),
      enumerate,
      map(([idx, [name, {val, min, range, ...rest}]]) => ({
        idx, name, val, min, range, ...rest,
        normalizedVal: list(map(val || [],
          v => (v-min)*0.7/(range||1)+idx+0.2)),
      })),
      list
    );

    const plot = new Gnuplot();
    plot.instruct(`unset label`);
    each(plots, ({idx, name, stdev, range, min, max, normalizedVal}) => {
      const label = `${name}, stdev=${millis(stdev)}, range=${millis(range)}[${millis(min)}; ${millis(max)}]`;
      const labelX = 1;
      const labelY = idx+1;
      plot.data(normalizedVal, name, { with: 'line' });
      plot.instruct(`set label ${JSON.stringify(label)} at ${labelX},${labelY} left front`)
    });
    plot.instruct(`set yrange [0:${plots.length}+0.2]`)
    plot.instruct(`set terminal pngcairo size 640, ${plots.length*480*0.25}`);
    plot.instruct(`unset key`);
    r.plot("jitter_comparison", "jitter comparison", plot);

    r.end();
  };

  let r = new ReportFile(`${outdir}/readme.md`);

  r.writeln(`# Report\n`);

  r.writeln(`[Peformance Score](./performance_score/)  \n`);
  reportMetricGroup(`performance_score`,
    (ana => ana.perf),
    (ana => ana.perf));

  each(metrics, metric => {
    r.writeln(`[${metric}](./${metric}/)  `);
    reportMetricGroup(metric,
      (ana => (ana.metrics[metric] || {}).score),
      (ana => (ana.metrics[metric] || {}).raw))
  });

  r.writeln(`\n# Experiments\n`);

  each(experiments, ([title, ex]) => {
    const dir = `./exp-${title}/`;
    r.writeln(`[${title}](${dir})  `);
    reportExperiment(title, `${outdir}/${dir}`, ex);
  });

  r.end();

  await Promise.all(forks);
};


const main = async (...rawArgs) => {
  const cmds = {
    lighthouse, analyze, makeca, standardTests, proxychrome,
    report,
  };

  const opts = minimist(rawArgs);
  const [cmd, ...pos] = opts._;

  let r = await cmds[cmd || 'standardTests'](...pos, opts);
  if (isdef(r) && type(r) !== String)
    r = JSON.stringify(r);
  if (isdef(r)) {
    // *sigh* console.log doesn't handle writes > 2^16-1 properly
    for (let off=0; off < r.length; off += 4096)
      process.stdout.write(r.slice(off, off+4096));
    process.stdout.write('\n');
  }
};

const init = async () => {
  try {
    process.on('uncaughtException', (err, origin) => debug(err, origin));
    process.on('unhandeledRejecion', (err) => debug(err));
    exitHandlers.push(() => rmdirSync(tmpdir, { recursive: true }));
    process.on('exit', () => each(exitHandlers, exec));
    await main(...process.argv.slice(2));
    process.exit();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};

init();
