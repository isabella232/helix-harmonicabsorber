const os = require('os');
const assert = require('assert');
const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const process = require('process');
const fs = require('fs');
const minimist = require('minimist');
const glob = require('fast-glob');
const jstat = require('jstat');
const hoxy = require('hoxy');
const child_process = require('child_process');
const chrome_remote = require('chrome-remote-interface');

const { abs } = Math;
const { assign } = Object;
const { resolve, dirname, basename } = require('path');
const { rmdirSync, createReadStream, createWriteStream } = fs;
const { mkdir, readFile } = fs.promises;
const { v4: uuidgen } = require('uuid');
const { isdef, map, exec, type, range, curry, setdefault, filter, each, identity, mapSort, list, pipe} = require('ferrum');
const { corrcoeff, spearmancoeff, mean, median, variance, deviation, stdev, meansqerr, skewness } = jstat;

/// CONFIG

const cakey = `${__dirname}/do_not_trust.key.pem`;
const cacert = `${__dirname}/do_not_trust.crt.pem`;
const tmpdir = `${os.tmpdir()}/harmonicabsorber-${new Date().toISOString()}-${uuidgen()}`

/// Run the subcommand
const exe = async (cmd, ...args /* , opts = {} */) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  const proc = child_process.spawn(cmd, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts,
  });
  const code = await new Promise((res, rej) => {
    proc.on('error', rej);
    proc.on('exit', (code) => res(code));
  });
  assert.strictEqual(code, 0);
  return proc;
};

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
  await fs.promises.writeFile(path, cont);
};

class Proxychrome {
  static create(...args) {
    return Object.create(this.prototype)._init(...args);
  }

  constructor() {
    assert(false, 'Use the static create() method to initialize this class');
  }

  async _init(opts) {
    const {
      headless,
      port = 5050,
      cache = false,
      cachedir = `${tmpdir}/cache/`,
    } = opts;
    assign(this, { cache, cachedir, cacheIndex: {}, fileCtr: 0 });

    const beforReturn = [];

    // Call destructor
    exitHandlers.push(() => this._exit());

    // Create cache dir
    const pCachedir = mkdir(cachedir, { recursive: true });

    // Load data
    const [key, cert] = await Promise.all([readFile(cakey), readFile(cacert)]);
    const proxyOpts = {
      certAuthority: { key, cert },
    };
    this.proxy = hoxy.createServer(proxyOpts).listen(port);
    this.proxy.intercept('request', (...args) => this._interceptReq(...args));
    this.proxy.intercept('response', (...args) => this._interceptResp(...args));

    // Launch chrome
    this.chrome = await chromeLauncher.launch({
      chromeFlags: [
        ...(headless ? ['--headless'] : []),
        `--proxy-server=http://localhost:${port}`,
        `--ignore-certificate-errors`,
      ]
    });

    await pCachedir;
    return this;
  }

  static _cacheKey(req) {
    const path = [
      this.cachedir,
      req.hostname, '/',
      req.url,
      req.url.endsWith('/') ? '__INDEX' : ''
    ];
    return path.join("");
  }

  async _interceptReq(req, resp, cycle) {
    if (!this.cache) return;

    const key = `${req.method} ${req.fullUrl()}`;
    const cached = this.cacheIndex[key];
    if (cached) {
      console.debug("CACHE HIT", key, cached);
      resp.statusCode = 404;
      each(cached.headers || {}, ([k, v]) => {
        resp.headers[k] = v
      });
      resp._source = createReadStream(`${this.cachedir}/${cached.index}`);
    } else {
      console.debug("CACHE MISS", key);
    }
  }

  async _interceptResp(req, resp, cycle) {
    if (!this.cache) return;

    const key = `${req.method} ${req.fullUrl()}`;
    if (this.cacheIndex[key]) return; // cache hit

    const cached = {
      headers: resp.headers,
      statusCode: resp.statusCode,
      index: this.fileCtr++,
    };
    console.debug("CREATE CACHE ENTRY ", key, cached);
    this.cacheIndex[key] = cached;
    resp.tee(createWriteStream(`${this.cachedir}/${cached.index}`));
  }

  async _exit() {
    if (isdef(this.chrome))
      this.chrome.kill();
  }
}

/// Start a proxy server on port 5050; this server will
/// cache ALL GET requests by full URL; it will work on http as
/// well as https traffic
const proxychrome = async (opts) => {
  await Proxychrome.create(opts);
  await new Promise(() => {}); // Does not resolve
};

/// Create the mock certificate authority used to intercept ssl traffic
const makeca = async () => {
  await exe('openssl', 'genrsa',
    '-out', cakey, '4096');
  await exe('openssl', 'req', '-x509', '-new', '-nodes',
    '-key', cakey,
    '-out', cacert,
    '-days', '10',
    '-subj', '/C=US/ST=Utah/L=Provo/O=DO NOT TRUST Helix Dummy Signing Authority DO NOT TRUST/CN=project-helix.io');
};

/// runLighthouse(...urls, opts={});
const runLighthouse = async (...args) => {
  const [urls, opts] = splitLast(args);
  if (type(opts) !== Object)
    return runLighthouse(...urls, opts, {});
  const { repeat = 1, cache } = opts;

  const { chrome, proxy } = await Proxychrome.create({ headless: true, cache });
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
    const lhr = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'));

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
    makeca,
    proxychrome: (opts) => proxychrome({ idle: true, ...opts }),
  };

  const opts = minimist(rawArgs);
  const [cmd, ...pos] = opts._;
  await cmds[cmd || 'lighthouse'](...pos, opts);
};

const init = async () => {
  try {
    process.on('uncaughtException', (err, origin) => console.warn(err, origin));
    process.on('unhandeledRejecion', (err) => console.warn(err));
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
