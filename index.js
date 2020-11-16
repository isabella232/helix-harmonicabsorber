const os = require('os');
const assert = require('assert');
const liblighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const process = require('process');
const fs = require('fs');
const minimist = require('minimist');
const glob = require('fast-glob');
const jstat = require('jstat');
const hoxy = require('hoxy');
const child_process = require('child_process');
const chrome_remote = require('chrome-remote-interface');
const yaml = require('yaml');
const marked = require('marked');

const { abs, min, max, round, ceil, floor } = Math;
const { assign } = Object;
const { resolve, dirname, basename } = require('path');
const { rmdirSync, createReadStream, createWriteStream } = fs;
const { mkdir, readFile, open } = fs.promises;
const { v4: uuidgen } = require('uuid');
const { corrcoeff, spearmancoeff, mean, median, variance, stdev, meansqerr, skewness } = jstat;
const {
  isdef, map, exec, type, range, curry, setdefault, filter, each,
  identity, mapSort, list, pipe, contains, is, keys, shallowclone,
  obj, dict, chunkify, values, first, uniq, enumerate, flat, get, concat, second, empty,
  chunkifyShort, next, range0, iter, foldl, sum, plus, mul, prepend, append,
} = require("ferrum");
const {isPlainObject, camelCase} = require('lodash');

/// CONFIG

const cakey = `${__dirname}/assets/do_not_trust.key.pem`;
const cacert = `${__dirname}/assets/do_not_trust.crt.pem`;
const procId = uuidgen();
const procTime = new Date();
const procTimeStr = procTime.toISOString().replace(/:/g, "-")
const tmpdir = `${os.tmpdir()}/harmonicabsorber-${procTimeStr}-${procId}`

const seqrange = (seq) => {
  const it = iter(seq), v0 = next(it);
  const [a, z] = foldl(it, [v0, v0],
    ([a, z], v) => [min(a, v), max(z, v)]);
  return [a, z, z-a];
};
const clamp = (v, a, z) => max(a, min(v, z));
const debug = (...args) => console.error(...args);
const debug_seq = (...args) => {
  const x = list(args.pop());
  debug("!!", ...args, x);
  return x;
};
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const backupProps = (o, props) => obj(map(props, k => [k, o[k]]));
const is_a = (v, t) => type(v) === t;
const is_any = (v, ts) => contains(ts, is(type(v)));
const assignDefaults = (o, pairs) => {
  each(pairs, ([k, v]) => {
    if (k in o) return;
    o[k] = v;
  });
};

/// Like a promise, but has resolve/reject methods
/// and a connect method that can resolve/reject from
/// another promise or barrier.
class Barrier extends Promise {
  constructor(fn) {
    let props;
    super((_res, _rej) => {
      props = { _res, _rej };
      if (isdef(fn))
        fn(_res, _rej);
    });
    assign(this, props);
  }

  resolve(v) {
    this._res(v);
  }

  reject(e) {
    this._rej(e);
  }

  connect(p) {
    p.then(this._res).catch(this._rej);
  }
};

const throws = (fn) => {
  try {
    fn();
    return false;
  } catch (_) {
    return true;
  }
};

const is_url = (s) => !throws(() => new URL(s));

/// Test if a file is accessible
const isAccessible = async (path) => {
  try {
    await fs.promises.access(path);
    return true;
  } catch (_) {
    return false;
  }
}

/// Run the subcommand
const exe = (cmd, ...args /* , opts = {} */) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  const proc = child_process.spawn(cmd, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts,
  });
  const onExit = new Promise((res, rej) => {
    proc.on('error', rej);
    proc.on('exit', (code) => res(code));
  }).then((code) => assert.strictEqual(code, 0));
  return { proc, onExit };
};

/// Run a command; potentially a node command
const npx = (...args) => {
  const opts = type(args[args.length - 1]) === Object ? args.pop() : {};
  const { env = process.env } = opts;
  const { PATH = process.env.PATH } = env;
  return exe(...args, {
    env: {
      ...env,
      PATH: `${__dirname}/node_modules/.bin/:${PATH}`,
    },
    ...opts,
  });
}

/// Spawn a helix simulator
const helixCliUp = async (name, repo, branch, commit, ...args) => {
  const { port, ...opts } = type(args[args.length - 1]) === Object ? args.pop() : {};
  const cwd = `${__dirname}/assets/repos/${name}`;

  // Clone git repo if necessary
  if (!(await isAccessible(cwd))) {
    await exe('git', 'clone', repo, cwd).onExit;
  }

  // Checkout commit
  await exe('git', 'checkout', '-B', branch, commit, { cwd }).onExit;

  const commandLine = [
    'hlx', 'up', '--no-open', '--log-level=warn',
    ...(isdef(port) ? ['--port', port]: []),
  ];
  await sleep(2);
  return npx(...commandLine, ...args, { cwd, ...opts, });
}

/// Like ferrum filter but applied specifically to the key of key
/// value pairs.
///
/// (* -> IntoBool) -> Sequence<[*, *]> -> Sequence<[*, *]>
const filterKey = curry('filterKey', (seq, fn) =>
  filter(seq, ([k, _]) => fn(k)));

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
  const [dir, _] = dirfile(path);
  await mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path, cont);
};


class AsyncCls {
  static async create(...args) {
    const r =  Object.create(this.prototype);
    await r._init(...args);
    exitHandlers.push(() => r._exit());
    return r;
  }

  constructor() {
    assert(false, `Use the static create() method to initialize ${typename(type(this))}.`);
  }

  _init() {}
  _exit() {}
}

const perc90 = (data) => {
  const discardNo = floor(data.length/20);
  const sorted = mapSort(list(data), identity);
  each(range0(discardNo), _ => {
    sorted.pop();
    sorted.shift();
  });
  return sorted;
};

const millis = n => round(n*1000);

const histogram = (data) => {
  if (!isdef(data) || empty(data))
    return [new Map(), 0];

  data =list(data);

  // 90th percentile sample + scotts rule
  const p90 = perc90(data);
  let binWidth = stdev(p90) * 3.49 * p90.length**(-1/3);
  if (binWidth === 0) binWidth = 0.1;

  const r = new Map();
  each(data || [], v => {
    const k = round(v/binWidth)*binWidth;
    r.set(k, (r.get(k) || 0) + 1);
  });

  return [r, binWidth];
};

class Proxychrome extends AsyncCls {
  async _init(opts) {
    let {
      port = 5050,
      cacheEnabled = false,
      cachedir = `${tmpdir}/cache/`,
      headless = false,
      helixStd = false,
      helix = [],
      rules = [],
    } = opts;

    // Provide helix env
    // if (helixStd) {
    //   rules = [
    //     ...rules,
    //     { match: 'localhost:10768/', hostname: 'pages.proxy-virtual' },
    //     { match: 'localhost:24030/', hostname: 'david-pages.proxy-virtual' },
    //   ];
    //   helix = [
    //     ...helix,
    //     {
    //       name: 'pages',
    //       repo: 'https://github.com/davidnuescheler/pages',
    //       branch: 'master',
    //       commit: '39771bf64df3c1999533cf3f63be683acdd014a6',
    //       port: 27666
    //     },
    //     {
    //       name: 'david-pages',
    //       branch: 'master',
    //       repo: 'https://github.com/davidnuescheler/pages',
    //       commit: 'd7530a37b62a1e29987b8c1c6f30cc870ca7b02f',
    //       port: 12914
    //     },
    //   ];
    // }

    // Parse Rules
    rules = pipe(
      // Enforce rules being a list
      is_any(rules, [String]) ? [rules] : rules,
      // Parse json inputs
      map(dat => is_any(dat, [String]) ? yaml.parse(dat) : dat),
      // Enforce match being a regexp
      map(({ match, ...rest }) => ({
        match: new RegExp(match),
        ...rest,
      })),
      list,
    );

    // Local variables
    assign(this, {
      cacheIndex: {},
      fileCtr: 0,
      cacheEnabled: Boolean(cacheEnabled),
      cachedir,
      rules, helix
    });

    // Start helix instances
    this.helix = list(helix);
    for (const inst of this.helix) {
      const {name, repo, branch, commit, ...hlxOpts} = inst;
      assign(inst, await helixCliUp(name, repo, branch, commit, hlxOpts));
    }

    // Create cache dir
    await mkdir(cachedir, { recursive: true });

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
        `--proxy-bypass-list=<-loopback>;<-local>`,
        `--ignore-certificate-errors`,
      ]
    });

    return this;
  }

  async _interceptReq(req, resp, cycle) {
    assignDefaults(req, {
      cacheEnabled: this.cacheEnabled,
      hosting: undefined,
      block: undefined,
      hostedFile: undefined,
      key: `${req.method} ${req.fullUrl()}`,
    });

    // Parse rules
    for (const {match, inverse = false, ...opts} of this.rules) {
      if (!req.key.match(match) ^ inverse) continue;
      assign(req, opts);

      // URL Rewriting
      const dest = `${req.method} ${req.fullUrl()}`;
      if (dest === req.key) continue;
      debug(`FORWARD ${req.key} -> ${dest}`);
      req.key = dest;
      return this._interceptReq(req, resp, cycle)
    }

    // Handle Proxy-virtual domains
    if (req.hostname.match(/\.proxy-virtual$/)) {
      const sub = req.hostname.split('.')[0];
      req.hosting = `${__dirname}/assets/static/${sub}/`;
    }

    // Handle blocking
    if (req.block) {
      debug("BLOCKING", req.key);
      resp.statusCode = 200;
      resp.content = "";
      return;
    }

    // Handle static hosting
    if (isdef(req.hosting) && !isdef(req.hostedFile)) {
      req.hostedFile = `${req.hosting}/${new URL(req.fullUrl()).pathname}`;
      debug("STATIC HOSTING", req.key, "in", req.hostedFile);
    }

    // Handle Caching
    if (req.cacheEnabled && !isdef(req.hostedFile)) {
      const cached = this.cacheIndex[req.key];
      if (cached) {
        //debug("CACHE HIT", req.key, cached);
        resp.statusCode = cached.statusCode;
        each(cached.headers || {}, ([k, v]) => {
          resp.headers[k] = v;
        });
        req.hostedFile = `${this.cachedir}/${cached.index}`;
      } else {
        debug("CACHE MISS", req.key);
      }
    }

    // Serve local files
    if (isdef(req.hostedFile)) {
      try {
        resp._source = await new Promise((res, rej) => {
          const str = createReadStream(req.hostedFile);
          str.on('error', rej);
          str.on('open', () => res(str));
        });
        if (!isdef(resp.statusCode))
          resp.statusCode = 200;
      } catch (e) {
        if (e.code === 'ENOENT') {
          resp.statusCode = 404;
        } else {
          resp.statusCode = 500;
          console.error(`${e.key}:\n\tException while serving file: ${req.hostedFile}:`, e);
        }
      }
    }
  }

  async _interceptResp(req, resp, cycle) {
    if (!req.cacheEnabled) return;

    if (this.cacheIndex[req.key]) return; // cache hit

    const cached = {
      headers: resp.headers,
      statusCode: resp.statusCode,
      index: this.fileCtr++,
    };
    //debug("CREATE CACHE ENTRY ", req.key, cached);
    this.cacheIndex[req.key] = cached;
    resp.tee(createWriteStream(`${this.cachedir}/${cached.index}`));
  }

  async _exit() {
    if (isdef(this.chrome))
      this.chrome.kill();
    each(this.helix, ({ proc }) =>
      proc.kill());
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
    '-out', cakey, '4096').onExit;
  await exe('openssl', 'req', '-x509', '-new', '-nodes',
    '-key', cakey,
    '-out', cacert,
    '-days', '10',
    '-subj', '/C=US/ST=Utah/L=Provo/O=DO NOT TRUST Helix Dummy Signing Authority DO NOT TRUST/CN=project-helix.io').onExit;
};

/// lighthouse(...urls, opts={});
const lighthouse = async (...args) => {
  const [urls, opts] = splitLast(args);
  if (type(opts) !== Object)
    return lighthouse(...urls, opts, {});

  let {
    repeat = 1,
    proxychrome = {},
    out = `harmonicabsorber_site_${procTimeStr}`,
  } = opts;

  if (type(proxychrome) === String)
    proxychrome = yaml.parse(proxychrome);
  if (isPlainObject(proxychrome))
    proxychrome = await Proxychrome.create(
      {headless: true, ...proxychrome});

  for (const url of urls) {
    const host = new URL(url).host;
    for (const idx of range(0, repeat)) {
      const { report, lhr, artifacts } = await liblighthouse(url, {
        logLevel: 'error',
        output: 'html',
        onlyCategories: ['performance'],
        port: proxychrome.chrome.port,
      });

      const dir = [
        out,
        ...(urls.length > 1 ? [host] : []),
        String(idx).padStart(6, '0')
      ].join('/');

      await writeFile(`${dir}/report.json`, JSON.stringify(lhr));
      await writeFile(`${dir}/artifacts.json`, JSON.stringify(artifacts));
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

  const characterizeData = (dat) => {
    dat = list(map(dat, d => d || 0));
    return {
      val: dat,
      min: jstat.min(dat),
      max: jstat.max(dat),
      range: jstat.range(dat),
      mean: mean(dat),
      median: median(dat),
      stdev: stdev(dat),
      skewness: skewness(dat),
    };
  };

  // Analyze statistical distributions of data collected
  assign(perf, characterizeData(perf.val));
  each(metrics, ([_, dat]) => {
    if (isdef((dat.raw || {}).val))
      assign(dat.raw, characterizeData(dat.raw.val));
    if (isdef((dat.score || {}).val))
      assign(dat.score, characterizeData(dat.score.val));
  });

  return { perf, metrics };
};

const standardTests = async (opts) => {
  let {
    repeat = 100,
    proxychrome = {},
    out = `harmonicabsorber_${procTimeStr}`,
  } = opts;

  if (type(proxychrome) === String)
    proxychrome = yaml.parse(proxychrome);
  if (isPlainObject(proxychrome))
    proxychrome = await Proxychrome.create(
      {headless: true, helixStd: true, ...proxychrome});

  let ctr = -1;
  const T = async (...mods) => {
    const opts_ = is_any(mods[mods.length - 1], [Object]) ? mods.pop() : {};
    const opts = pipe(opts_, ...mods);
    let {
      name: basename, url, rules = [], cacheEnabled = false, ...rest
    } = opts;

    ctr+=1;

    const name = [
      ...(isdef(basename) ? [basename] : []),
      ...map(mods, ({name}) => name),
    ].join('+').replace(/_/g, '+');

    debug("RUN LIGHTHOUSE ", name, {rules, cacheEnabled, url, ...rest });

    const backup = backupProps(proxychrome, ['rules', 'cacheEnabled']);
    try {
      assign(proxychrome, {
        rules: [...rules, ...proxychrome.rules],
        cacheEnabled,
      });
      await lighthouse(url, {
        out: `${out}/${String(ctr).padStart(6, '0')}-${name}`,
        repeat, proxychrome, ...rest,
      });
    } finally {
      assign(proxychrome, backup);
    }
  };

  // Envs
  const envs = dict(chunkify(2)([
    'empty', 'http://baseline.proxy-virtual/empty.html',
    // 'simulator', 'http://localhost:27666/creativecloud/en/ete/how-adobe-apps-work-together/',
    'pages', 'https://pages--adobe.hlx.page/creativecloud/en/ete/how-adobe-apps-work-together/',
    // 'online', 'https://pages.adobe.com/illustrator/en/tl/thr-illustration-home/',
    // 'simulator_statified', 'http://localhost:10768/illustrator/en/tl/thr-illustration-home/index.html',
    // 'simulator_david', 'http://localhost:12914/creativecloud/en/ete/how-adobe-apps-work-together/',
    // 'pages_david', 'https://pages--davidnuescheler.hlx.page/creativecloud/en/ete/how-adobe-apps-work-together/',
    // 'simulator_statified_david', 'http://localhost:24030/illustrator/en/tl/thr-illustration-home/index.html',
  ]));

  // Mods
  const addRules = ({ rules = [], ...opts }, newRules) => ({
    ...opts,
    rules: [...newRules, ...rules,],
  });
  const pages = (opts) => ({ url: envs.get('pages'), ...opts});
  const cached = (opts) => ({ cacheEnabled: true, ...opts });
  const nointeractive = (opts) => addRules(opts, [
    { match: /stats.adobe.com|facebook.com|facebook.net/, block: true },
  ]);
  const noadtech = (opts) => addRules(nointeractive(opts), [
    { match: /adobe-privacy\/latest\/privacy.min|marketingtech|demdex.net|cookielaw.org|geolocation.onetrust.com/, block: true },
  ]);
  const noexternal = (opts) => addRules(opts, [
    { match: /pages--adobe.hlx.page/, block: true, inverse: true },
  ]);
  const nofonts = (opts) => addRules(opts, [
    { match: /\/hlx_fonts\//, block: true },
  ]);
  const nosvg = (opts) => addRules(opts, [
    { match: /\.svg([?#].*)?$/, block: true },
  ]);
  const noimg = (opts) => addRules(opts, [
    { match: /\.(png|jpg|jpeg)([?#].*)?$/, block: true },
  ]);
  const nocss = (opts) => addRules(opts, [
    { match: /\.css([?#].*)?$/, block: true },
  ]);
  const nojs = (opts) => addRules(opts, [
    { match: /\.js([?#].*)?$/, block: true },
  ]);

  // Execute all the basic environments
  for (const [name, url] of envs)
    await T({ name, url });

  // Just execute each environment as a baseline
  await T(pages, cached);
  await T(pages, cached, nointeractive);
  await T(pages, cached, noadtech);
  await T(pages, cached, noexternal);
  await T(pages, cached, noexternal, nofonts);
  await T(pages, cached, noexternal, nosvg);
  await T(pages, cached, noexternal, noimg);
  await T(pages, cached, noexternal, nocss);
  await T(pages, cached, noexternal, nojs);
  await T(pages, cached, noexternal, nofonts, nosvg, noimg);
  await T(pages, cached, noexternal, nofonts, nosvg, noimg, nocss);
  await T(pages, cached, noexternal, nofonts, nosvg, noimg, nocss, nojs);
};

class TextFile {
  constructor(file, _opts = {}) {
    assign(this, { file, buf: [] });
  }

  write_seq(seq) {
    each(seq, v => this.buf.push(v));
    return this;
  }

  write(...toks) {
    return this.write_seq(toks);
  }

  writeln(...toks) {
    return this.write(...toks, '\n');
  }

  write_list(seq, opts = {}) {
    const { delim = '\n' } = opts;
    each(seq, l => {
      this.write(l)
      this.write(delim)
    });
    return this;
  }

  write_table(seq, opts = {}) {
    const { delim = '\n', col_sep = ' ' } = opts;
    each(seq, col => {
      this.write_with_sep(col, col_sep);
      this.write(delim);
    });
    return this;
  }

  write_with_sep(seq, sep) {
    each(enumerate(seq), ([idx, v]) => {
      if (idx !== 0)
        this.buf.push(sep);
      this.buf.push(v);
    });
    return this;
  }

  end() {
    return writeFile(this.file, this.buf.join(''));
  }
}

class Gnuplot {
  constructor(opts = {}) {
    const {
      datasets = [],
      instructions = [],
      plotOpts = [],
    } = opts;
    assign(this, { datasets, instructions, plotOpts, });
  }

  data(seq, name, opts) {
    opts = isdef(opts) ? opts : [];
    name = isdef(name) ? name : this.datasets.length;
    this.datasets.push({
      type: 'list',
      data: list(seq),
      name,
      plotOpts: list(opts),
    });
    return this;
  }

  ident(name) {
    name = camelCase(String(name));
    if (name.match(/^[0-9]/))
      name = `_${name}`;
    return name;
  }

  table(seq, name, opts) {
    opts = isdef(opts) ? opts : [];
    name = isdef(name) ? name : `_${this.datasets.length}`;
    this.datasets.push({
      type: 'table',
      data: list(map(seq, list)),
      name,
      plotOpts: list(opts),
    });
    return this;
  }

  instruct(...instruction) {
    this.instructions.push(instruction.join(' '));
    return this;
  }

  popt(opts) {
    each(opts, o => this.opts.push(o));
    this.plotOpts.push(list(opts));
    return this;
  }

  all_values() {
    return flat(map(this.datasets, d =>
        d.type === 'list' ? d.data : map(d.data, second)));
  }

  ymin(...args) {
    return jstat.min(list(this.all_values(...args)));
  }

  ymax(...args) {
    return jstat.max(list(this.all_values(...args)));
  }

  yrange(...args) {
    return this.ymin(...args) - this.ymax(...args);
  }

  normalizeYrange(opts = {}) {
    let {
      a = this.ymin(),
      z = this.ymax(),
      minOff = 1e-3,
      off = max((z - a) * 0.02, minOff),
    } = opts;
    return this.instruct(`set yrange [${a-off}:${z+off}]`)
  }

  async plot(file, instruction = null) {
    const w = new TextFile(`${file}.gnuplot`);

    each(this.datasets, ({ name, type, data }) => {
      w.writeln(`$_${this.ident(name)} <<EOF`);
      if (type === 'list')
        w.write_list(data);
      else
        w.write_table(data);
      w.writeln(`EOF`);
    });

    w.writeln(`set key outside below`);
    w.writeln(`set terminal pngcairo`);
    w.writeln(`set output ${JSON.stringify(`${file}.png`)}`);
    w.write_list(this.instructions);

    if (isdef(instruction)) {
      w.writeln(instruction);
    } else {
      w.write(`plot `);
      each(this.datasets, ({ name, plotOpts }) => {
        w.write(`$_${this.ident(name)} title ${JSON.stringify(name)} `);
        each(concat(this.plotOpts, plotOpts), opt => {
          if (is_a(opt, String))
            w.write(opt, ' ');
          else
            each(opt, o => w.write(o, ' '));
        });
        w.write(`,`);
      });
    }

    await w.end();

    // Run Gnuplot
    if (empty(list(this.all_values()))) {
      debug(`Skipping empty GNUPLOT:${file}.gnuplot`)
    } else {
      await type(this).exec(`${file}.gnuplot`);
    }
  }

  static initShed() {
    if (!isdef(this.queue)) {
      assign(this, {
        queue: [],
        procno: 0,
        maxProcs: 8,
        batchSz: 10,
        minBatchSz: 5,
        maxBatchSz: 40,
      });
    }
  }

  static exec(filename) {
    this.initShed();
    const r = new Barrier();
    this.queue.push([filename, r]);
    this.sched();
    return r;
  }

  static sched() {
    this.initShed();
    if (this.procno >= this.maxProcs)
      return;

    try {
      while (!empty(this.queue) && this.procno <= this.maxProcs)
        this.fork(this.queue.splice(0, this.batchSz));

      let growth = 1;
      if (this.procno < this.maxProcs) // Short on jobs
        growth = 0.7;
      else if (!empty(this.queue))
        growth = 1.3;

      this.batchSz = clamp(round(this.batchSz * growth),
        this.minBatchSz, this.maxBatchSz);
    } catch (_) {
      // pass
    }
  }

  static async fork(pairs) {
    if (empty(pairs))
      return;

    try {
      this.procno += 1;
      await exe('gnuplot', ...map(pairs, first)).onExit;
    } catch (_) {}

    try {
      each(pairs, ([_, barrier]) => barrier.resolve());
    } catch (_) {}

    this.procno -= 1;
    this.sched();
  }
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

    // Display comparisons

    r.writeln('\n## Comparison\n');

    each(combos, combo => {
      const plotName = [name, ...combo].join('_');
      const plot = new Gnuplot();
      const hist = new Gnuplot();
      let hw = 1;
      each(combo, title => {
        const analysis = getScoreAnalysis(experiments.get(title));
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
      mapSort(([_, v]) => stdev(perc90(v.val))),
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
    (_   => ({})));

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
