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

const { abs } = Math;
const { assign } = Object;
const { resolve, dirname, basename } = require('path');
const { rmdirSync, createReadStream, createWriteStream } = fs;
const { mkdir, readFile } = fs.promises;
const { v4: uuidgen } = require('uuid');
const { corrcoeff, spearmancoeff, mean, median, variance, stdev, meansqerr, skewness } = jstat;
const {
  isdef, map, exec, type, range, curry, setdefault, filter, each, identity,
  mapSort, list, pipe, contains, is, keys, shallowclone, obj, dict,
  chunkify,
} = require("ferrum");
const {isPlainObject} = require('lodash');

/// CONFIG

const cakey = `${__dirname}/assets/do_not_trust.key.pem`;
const cacert = `${__dirname}/assets/do_not_trust.crt.pem`;
const procId = uuidgen();
const procTime = new Date();
const procTimeStr = procTime.toISOString().replace(/:/g, "-")
const tmpdir = `${os.tmpdir()}/harmonicabsorber-${procTimeStr}-${procId}`

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const backupProps = (o, props) => obj(map(props, k => [k, o[k]]));
const is_any = (v, ts) => contains(ts, is(type(v)));
const assignDefaults = (o, pairs) => {
  each(pairs, ([k, v]) => {
    if (k in o) return;
    o[k] = v;
  });
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
const exe = async (cmd, ...args /* , opts = {} */) => {
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
    if (helixStd) {
      rules = [
        ...rules,
        { match: 'localhost:10768/', hostname: 'pages.proxy-virtual' },
        { match: 'localhost:24030/', hostname: 'david-pages.proxy-virtual' },
      ];
      helix = [
        ...helix,
        {
          name: 'pages',
          repo: 'https://github.com/davidnuescheler/pages',
          branch: 'master',
          commit: '39771bf64df3c1999533cf3f63be683acdd014a6',
          port: 27666
        },
        {
          name: 'david-pages',
          branch: 'master',
          repo: 'https://github.com/davidnuescheler/pages',
          commit: 'd7530a37b62a1e29987b8c1c6f30cc870ca7b02f',
          port: 12914
        },
      ];
    }

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
      console.debug(`FORWARD ${req.key} -> ${dest}`);
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
      console.debug("BLOCKING", req.key);
      resp.statusCode = 404;
      return;
    }

    // Handle static hosting
    if (isdef(req.hosting) && !isdef(req.hostedFile)) {
      req.hostedFile = `${req.hosting}/${new URL(req.fullUrl()).pathname}`;
      console.debug("STATIC HOSTING", req.key, "in", req.hostedFile);
    }

    // Handle Caching
    if (req.cacheEnabled && !isdef(req.hostedFile)) {
      const cached = this.cacheIndex[req.key];
      if (cached) {
        //console.debug("CACHE HIT", req.key, cached);
        resp.statusCode = cached.statusCode;
        each(cached.headers || {}, ([k, v]) => {
          resp.headers[k] = v;
        });
        req.hostedFile = `${this.cachedir}/${cached.index}`;
      } else {
        console.debug("CACHE MISS", req.key);
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
    //console.debug("CREATE CACHE ENTRY ", req.key, cached);
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
  if (isPlainObject()(proxychrome) === Object)
    proxychrome = await Proxychrome.create(
      {headless: true, ...proxychrome});

  for (const url of urls) {
    const host = new URL(url).host;
    for (const idx of range(0, repeat)) {
      const { report, lhr } = await liblighthouse(url, {
        logLevel: 'error',
        output: 'html',
        onlyCategories: ['performance'],
        port: proxychrome.chrome.port
      });

      const dir = `${out}/${host}/${String(idx).padStart(6, '0')}`;
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

  let ctr = 0;
  const T = async (...mods) => {
    const opts_ = is_any(mods[mods.length - 1], [Object]) ? mods.pop() : {};
    const opts = pipe(opts_, ...mods);
    let {
      name: basename, url, rules = [], cacheEnabled = false, ...rest
    } = opts;

    const name = [
      ...(isdef(basename) ? [basename] : []),
      ...map(mods, ({name}) => name),
    ].join('+').replace(/_/g, '+');

    console.debug("RUN LIGHTHOUSE ", name, {rules, cacheEnabled, url, ...rest });

    const backup = backupProps(proxychrome, ['rules', 'cacheEnabled']);
    try {
      assign(proxychrome, {
        rules: [...rules, proxychrome.rules],
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
    'simulator', 'http://localhost:27666/creativecloud/en/ete/how-adobe-apps-work-together/',
    'pages', 'https://pages--adobe.hlx.page/creativecloud/en/ete/how-adobe-apps-work-together/',
    'online', 'https://pages.adobe.com/illustrator/en/tl/thr-illustration-home/',
    'simulator_statified', 'http://localhost:10768/illustrator/en/tl/thr-illustration-home/index.html',
    'simulator_david', 'http://localhost:12914/creativecloud/en/ete/how-adobe-apps-work-together/',
    'pages_david', 'https://pages--davidnuescheler.hlx.page/creativecloud/en/ete/how-adobe-apps-work-together/',
    'simulator_statified_david', 'http://localhost:24030/illustrator/en/tl/thr-illustration-home/index.html',
  ]));

  // Mods
  const addRules = ({ rules = [], ...opts }, newRules) => ({
    ...opts,
    rules: [...newRules, ...rules,],
  });
  const simulator = (opts) => ({ url: envs.get('simulator'), ...opts});
  const cached = (opts) => ({ cacheEnabled: true, ...opts });
  const nointeractive = (opts) => addRules(opts, [
    { match: /stats.adobe.com|facebook.com|facebook.net/, block: true },
  ]);
  const noadtech = (opts) => addRules(nointeractive(opts), [
    { match: /adobe-privacy\/latest\/privacy.min|marketingtech|demdex.net|cookielaw.org|geolocation.onetrust.com/, block: true },
  ]);
  const noexternal = (opts) => addRules(opts, [
    { match: /::1|127.0.0.1|localhost/, block: true, inverse: true },
  ]);
  const nocss = (opts) => addRules(opts, [
    { match: /\.css([?#])/, block: true },
  ]);
  const nojs = (opts) => addRules(opts, [
    { match: /\.js([?#])/, block: true },
  ]);

  // Execute all the basic environments
  for (const [name, url] of envs)
    await T({ name, url });

  // Just execute each environment as a baseline
  await T(simulator, cached);
  await T(simulator, cached, nointeractive);
  await T(simulator, cached, noadtech);
  await T(simulator, cached, noexternal);
  await T(simulator, cached, noexternal, nocss);
  await T(simulator, cached, noexternal, nocss, nojs);
};

const main = async (...rawArgs) => {
  const cmds = {
    lighthouse, analyze, makeca, standardTests, proxychrome };

  const opts = minimist(rawArgs);
  const [cmd, ...pos] = opts._;
  await cmds[cmd || 'standardTests'](...pos, opts);
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
