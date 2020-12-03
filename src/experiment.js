import lighthouse_lib_ from 'lighthouse';
import { resolve } from 'path';
import { range0, isdef, curry, enumerate, each } from 'ferrum';
import { debug } from './stuff';
import { Proxychrome, cacheRequest } from './proxychrome';
import { procTimeStr } from './settings';
import { writeFile } from './asyncio';

const { assign } = Object;

const lighthouse_eval_ = async (opts) => {
  let { proxychrome, out, url } = opts;

  for (const idx of range0(100)) {
    const { report, lhr, artifacts } = await lighthouse_lib_(url, {
      logLevel: 'error',
      output: 'html',
      onlyCategories: ['performance'],
      port: proxychrome.chrome.port,
    });

    const out_ = `${out}/${String(idx).padStart(6, '0')}`;
    await writeFile(`${out_}/report.json`, JSON.stringify(lhr));
    await writeFile(`${out_}/artifacts.json`, JSON.stringify(artifacts));
    await writeFile(`${out_}/report.html`, report);
  }
};

/// Run lighthouse and write results to the given dir
const lighthouse = async (opts, fn) => {
  const { intercept = fn, ...rest } = opts;
  const { proxychrome } = opts;

  if (!isdef(intercept)) {
    return await lighthouse_eval_(rest);
  }

  const a = proxychrome.onResponse;
  const f = (req, res, cycle) => {
    try {
      intercept({...res, req, res, cycle});
    } catch (e) {
      if (e !== JUMP)
        throw e;
    }
  }

  try {
    a.push(fn);
    return await lighthouse_eval_(rest);
  } finally {
    a.splice(a.indexOf(f), 1);
  }
};

// Experiment helpers --------------------

const JUMP = Symbol("JUMP");

const cache = ({ req, res, ...rest }) =>
  cacheRequest(req, res, rest);

const block = ({ req, res, because }) => {
  debug('Blocking', req.fullUrl(),
    ...(isdef(because) ? ['because', because] : []));
  assign(res, { statusCode: 200, content: "" })
  throw JUMP;
};

const blockSuffix = curry('blockSuffix', (opts, suffix) => {
  const usuf = new URL(opts.req.fullUrl()).pathname.replace(/^.*\./, '');
  if (usuf === suffix)
    block({ because: `Suffix:${suffix}`, ...opts });
});

const blockExternal = (opts) => {
  const u1 = new URL(opts.req.fullUrl()), u2 = new URL(opts.url);
  if (u1.host !== u2.host)
    block({ because: `External resource`, ...opts });
};

// Experiments --------------------------

const emptyUrl = `file://${resolve('../assets/static/baseline/empty.html')}`;
const pagesUrl = 'https://pages--adobe.hlx.page/creativecloud/en/ete/how-adobe-apps-work-together/';

const deriveExp = (name, base, intercept) => ({
  ...base,
  name: `${base.name}+${name}`,
  intercept(opts) {
    if (isdef(intercept))
      intercept(opts);
    if (isdef(base.intercept))
      base.intercept(opts);
  }
});

const expEmpty = { name: 'empty', url: emptyUrl };
const expPages = { name: 'pages', url: pagesUrl };
const expCached = deriveExp('cached', expPages, cache);
const expNoexternal = deriveExp('noexternal', expCached, blockExternal);
const expNomedia = deriveExp('nomedia', expNoexternal, (opts) => {
  blockSuffix(opts, 'svg');
  blockSuffix(opts, 'jpg');
  blockSuffix(opts, 'jpeg');
  blockSuffix(opts, 'png');
});
const expNocss = deriveExp('nocss', expNomedia, blockSuffix('css'));
const expNojs = deriveExp('nojs', expNocss, blockSuffix('js'));

const experiments = [
  expEmpty, expPages, expCached, expNoexternal,
  expNomedia, expNocss, expNojs
];

export const runExperiment = async () => {
  const dir = `harmonicabsorber_${procTimeStr}`;
  const proxychrome = await Proxychrome.new();
  each(enumerate(experiments), ([idx, { name, ...rest }]) => {
    const out = `${dir}/${String(idx).padStart(6, '0')}-${name}`;
    lighthouse({ proxychrome, out, ...rest });
  });
};
