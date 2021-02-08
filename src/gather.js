import assert from 'assert';
import process from 'process';
import child_process from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { isdef, curry, enumerate, pipe, map, dict, eq } from 'ferrum';
import { v4 as uuidgen } from 'uuid';
import { debug } from './stuff.js';
import { Proxychrome, cacheRequest } from './proxychrome.js';
import { procTimeStr, tmpdir } from './settings.js';
import { BufferedChannel, fork, forknCoro, sleep } from './asyncio.js';
import { trySelectWithWeight } from './ferrumpp.js';
import { minimum } from './math.js';

const { assign } = Object;
const { random } = Math;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Experiment helpers --------------------

const JUMP = Symbol("JUMP");

const cache = ({ proxychrome, req, res, cycle, ...opts }) =>
  cacheRequest(proxychrome, req, res, cycle, ...opts);

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

const pagesUrl = 'https://pages.adobe.com/illustrator/en/tl/thr-layout-home/';

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
  expPages, expCached, expNoexternal,
  expNomedia, expNocss, expNojs
];

export const gather = async () => {
  const maxWorkers = 3;
  const dir = `harmonicabsorber_${procTimeStr}`;

  const exps2 = pipe(
    enumerate(experiments),
    map(([idx, { name, ...opts }]) => [name, {
      ...opts, todo: 100, repeat: 100, idx, name,
    }]),
    dict);

  const proxychrome = await Proxychrome.new();
  proxychrome.onResponse.push((_, req, res, cycle) => {
    // We use the header to determine which experimental setup
    // is to be used
    const expName = req.headers['x-harmonicobserver-experiment'];
    const exp = exps2.get(expName);
    console.log("EXPERIMENT ", expName);
    if (!isdef(exp))
      return;

    // Need separate caches per experiment
    const cacheDir = `${tmpdir()}/cache-${proxychrome.proxychromeId}-${expName}`

    // Make that entire throw JUMP feature work
    try {
      exp.intercept({ proxychrome, req, res, cycle, cacheDir });
    } catch (e) {
      if (e !== JUMP)
        throw e;
    }
  });

  await forknCoro(maxWorkers, async () => {
    // Lighthouse doesn't expect running multiple times in the same browser
    const chrome = await proxychrome.launchChrome();

    // Not in the same node instance…using workers to remedy this
    const worker = fork(`${__dirname}/gather.lighthouse_worker.js`);
    const msgs = BufferedChannel.new();
    let ready = false;
    worker.on('message', (m) => {
      if (eq(m, { what: 'ready' })) {
        ready = true;
      } else {
        msgs.enqueue(m)
      }
    });

    // For some reason the process IPC is brittle as hell at startup;
    // to avoid a sleep() in the dark, I created this handshake…
    while (true) {
      worker.send({ what: 'ready' });
      if (ready) break;
      await sleep(10);
    }

    while (true) {
      // Select a random experiment to execute; we randomize these
      // to distribute effects from the test environment like cpu load,
      // network load, etc. randomly among different experiments.
      // If we just executed the experiments in sequence, they would
      // run at very different times which might reduce the quality of our results.
      // We use a weighted selector so experiment selection approaches
      // round robin (but is not exactly round robin)
      // The weight function below makes sure that experiments that have
      // been run more often are much less likely to be selected
      const minTodo = minimum(map(exps2, ([_name, { todo }]) => todo))
      const exp = pipe(
        map(exps2, ([_name, e]) => [e.todo === 0 ? 0 : (e.todo - minTodo + 1)**2, e]),
        trySelectWithWeight(null, random()));
      if (!isdef(exp))
        break;

      const { idx, todo, repeat, name, url } = exp;
      const ctr = repeat - todo;
      const out = `${dir}/${String(idx).padStart(6, '0')}-${name}/${String(ctr).padStart(6, '0')}`;
      exp.todo--;

      const jobId = uuidgen();
      console.log("--- ", worker.send);
      worker.send({
        what: 'lighthouse',
        out, url, jobId,
        port: chrome.port,
        extraHeaders: {
          'x-harmonicobserver-experiment': name
        },
      });

      // Wait until job completion
      // TODO: Timeout?
      const { what, jobId: jobId_ } = await msgs.dequeue();
      assert(what === 'lighthouse_done');
      assert(jobId === jobId_);
    }

    worker.send({ what: `quit` });
  });
};
