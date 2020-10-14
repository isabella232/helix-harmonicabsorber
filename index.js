const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const process = require('process');
const fs = require('fs/promises');
const minimist = require('minimist');
const glob = require('fast-glob');
const jstat = require('jstat');

const { abs } = Math;
const { assign } = Object;
const { resolve, dirname, basename } = require('path');
const { mkdir, readFile } = fs;
const { isdef, map, exec, type, range, curry, setdefault, filter, each, identity, mapSort, list, pipe} = require('ferrum');
const { corrcoeff, spearmancoeff, mean, median, variance, deviation, stdev, meansqerr, skewness } = jstat;

/// Like ferrum filter but applied specifically to the key of key
/// value pairs.
///
/// (* -> IntoBool) -> Sequence<[*, *]> -> Sequence<[*, *]>
const filterKey = curry('filterKey', (seq, fn) =>
  filter(seq, ([k, v]) => fn(k)));

/// Like ferrum map but transforms the key specifically from key/value pairs.
///
/// (* -> *) -> Sequence<[*, *]> -> Sequence<[*, *]>
const mapKey = curry('mapKey', (seq, fn) =>
  map(seq, ([k, v]) => [fn(k), v]));

/// List of (async) functions to run on regular script exit
const exitHandlers = [];

/// Deconstructs a sequence into initial sequence and tail
const splitLast = (seq) => {
  const s = list(seq);
  return [s, s.pop()];
}

/// Resolve path and decompose into directory/base
/// String -> [String, String]
const dirfile = (path) => {
  const p = resolve(path);
  return [dirname(p), basename(p)];
};

const linearizeJson = (v, _prefix = []) =>
  type(v) !== Object && type(v) !== Array ? [_prefix, v] :
    flat(map(pairs(v), ([k, v]) =>
      linearizeJson(v, [..._prefix, k])));

/// Write file; creating the dir if need be
const writeFile = async (path, cont) => {
  const [dir, file] = dirfile(path);
  await mkdir(dir, { recursive: true });
  await fs.writeFile(path, cont);
};

let chromeInstance = null;
const getChrome = async () => {
  if (!isdef(chromeInstance)) {
    chromeInstance = await chromeLauncher.launch({chromeFlags: ['--headless']});
    exitHandlers.push(() => chromeInstance.kill());
  }
  return chromeInstance;
};

/// runLighthouse(...urls, opts={});
const runLighthouse = async (...args) => {
  const [urls, opts] = splitLast(args);
  if (type(opts) !== Object)
    return runLighthouse(...urls, opts, {});
  const { repeat = 1 } = opts;

  const chrome = await getChrome();
  const outDir = `harmonicabsorber_${new Date().toISOString()}`;

  const metrics = {};

  for (const url of urls) {
    const host = new URL(url).host;
    for (const idx of range(0, repeat)) {
      const { report, lhr } = await lighthouse(url, {
        logLevel: 'info',
        output: 'html',
        onlyCategories: ['performance'],
        port: chrome.port
      });

      const dir = `${outDir}/${host}/${String(idx).padStart(6, '0')}`;
      await writeFile(`${dir}/report.json`, JSON.stringify(lhr));
      await writeFile(`${dir}/report.html`, report);
    }
  }
};

const analyze = async (dir) => {
  const perf = {
    val: [],
  };
  const metrics = {};

  const addMetric = (name, type, idx, val) => {
    if (isdef(val)) {
      const meta = setdefault(metrics, name, {});
      const obj = setdefault(meta, type, {})
      const series = setdefault(obj, 'val', [])
      series[idx] = val;
    }
  };

  const reports = await glob('*/report.json', { cwd: dir });
  await Promise.all(map(reports, async (file) => {
    const no = Number(file.split('/')[0]);
    const lhr = JSON.parse(await readFile(`${dir}/${no}/report.json`, 'utf8'));

    perf.val[no] = lhr.categories.performance.score;
    each(lhr.audits, ([audit, data]) => {
      addMetric(audit, 'raw', no, data.numericValue);
      addMetric(audit, 'score', no, data.score);
    });
  }));

  const characterizeData = (dat) => ({
    min: jstat.min(dat),
    max: jstat.max(dat),
    range: jstat.range(dat),
    mean: mean(dat),
    median: median(dat),

    meansqerr: meansqerr(dat),
    variance: variance(dat),
    stdev: stdev(dat),
    skewness: skewness(dat),
  });

  // Analyze statistical distributions of data collected
  assign(perf, characterizeData(perf.val));
  each(metrics, ([_, dat]) => {
    if (isdef((dat.raw || {}).val))
      assign(dat.raw, characterizeData(dat.raw.val));
    if (isdef((dat.score || {}).val))
      assign(dat.score, characterizeData(dat.score.val));
  });

  const characterizeCorrelation = (dat, dat2) => ({
    rho: corrcoeff(dat, dat2),
    spearman_rho: spearmancoeff(dat, dat2),
  });

  // Analyze correlation
  each(metrics, ([_, met]) => {
    if (isdef((met.raw || {}).val))
      assign(met.raw, characterizeCorrelation(met.raw.val, perf.val));
    if (isdef((met.score || {}).val))
      assign(met.score, characterizeCorrelation(met.score.val, perf.val));
  });

  // Rank values
  const ranks = {};
  const mkrank = (name, type, val, norm = identity) => {
    ranks[name] = pipe(
      metrics,
      map(([name, meta]) => [name, (meta[type] || {})[val]]),
      filter(([_, v]) => isdef(v) && Number.isFinite(v)),
      mapSort(([_, score]) => -norm(score)),
    );
  };

  mkrank('rho',                'raw',   'rho',          abs);
  mkrank('spearman_rho',       'raw',   'spearman_rho', abs);
  mkrank('score_rho',          'score', 'rho',          abs);
  mkrank('score_spearman_rho', 'score', 'spearman_rho', abs);

  mkrank('mean',      'score', 'mean');
  mkrank('median',    'score', 'median');
  mkrank('meansqerr', 'score', 'meansqerr');
  mkrank('stdev',     'score', 'stdev');
  mkrank('skewness',  'score', 'skewness');

  console.log(JSON.stringify({ perf, metrics, ranks }));
};

const main = async (...rawArgs) => {
  const cmds = {
    lighthouse: runLighthouse,
    analyze,
  };

  const opts = minimist(rawArgs);
  const [cmd, ...pos] = opts._;
  await cmds[cmd || 'lighthouse'](...pos, opts);
};

const init = async () => {
  try {
    await main(...process.argv.slice(2));
    await Promise.all(map(exitHandlers, exec));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};

init();
