const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const process = require('process');
const fs = require('fs/promises');
const minimist = require('minimist');

const { resolve, dirname, basename } = require('path');
const { mkdir } = fs;
const { isdef, map, exec, type, range, curry, setdefault, filter, each } = require('ferrum');

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

const runLighthouse = async (url, opts = {}) => {
  let { repeat = 1, } = opts;

  const chrome = await getChrome();
  const outDir = `${new URL(url).host}_${new Date().toISOString()}`;

  const metrics = {};

  for (const idx of range(0, repeat)) {
    const { report, lhr } = await lighthouse(url, {
      logLevel: 'info',
      output: 'html',
      onlyCategories: ['performance'],
      port: chrome.port
    });

    await writeFile(`${outDir}/${idx}/report.json`, JSON.stringify(lhr));
    await writeFile(`${outDir}/${idx}/report.html`, report);

    // Metrics

    const addMetric = (name, val) => {
      if (isdef(val)) {
        const series = setdefault(metrics, name, [])
        series[idx] = val;
      }
    };

    addMetric('performance_score', lhr.categories.performance.score);
    each(lhr.audits, ([audit, data]) => {
      addMetric(audit, data.numericValue);
      addMetric(`${audit}_score`, data.score);
    });

    await writeFile(`${outDir}/metrics.js`, JSON.stringify(metrics));
  }
};

const main = async (...rawArgs) => {
  const cmds = {
    lighthouse: runLighthouse,
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
