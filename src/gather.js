import assert from 'assert';
import process from 'process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidgen } from 'uuid';
import { debug } from './stuff.js';
import { Proxychrome, cacheRequest } from './proxychrome.js';
import { procTimeStr, tmpdir } from './settings.js';
import { BufferedChannel, fork, forknCoro, sleep } from './asyncio.js';
import { trySelectWithWeight } from './ferrumpp.js';
import { minimum } from './math.js';
import {
  isdef, curry, enumerate, pipe, map, dict, eq,
} from 'ferrum';

const { assign } = Object;
const { random } = Math;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Experiment helpers --------------------

const JUMP = Symbol("JUMP");

const cache = async ({ proxychrome, req, res, cycle, ...opts }) =>
  await cacheRequest(proxychrome, req, res, cycle, opts);

const block = async ({ req, res, because }) => {
  debug('Blocking', req.fullUrl(),
    ...(isdef(because) ? ['because', because] : []));
  assign(res, { statusCode: 200, content: "" })
  throw JUMP;
};

const blockSuffix = curry('blockSuffix', async (opts, suffix) => {
  const usuf = new URL(opts.req.fullUrl()).pathname.replace(/^.*\./, '');
  if (usuf === suffix)
    await block({ because: `Suffix:${suffix}`, ...opts });
});

// Experiments --------------------------

const pagesUrl = 'https://pages.adobe.com/illustrator/en/tl/thr-layout-home/';

const deriveExp = (name, base, intercept) => ({
  ...base,
  name: `${base.name}+${name}`,
  async intercept(opts) {
    if (isdef(intercept))
      await intercept(opts);
    if (isdef(base.intercept))
      await base.intercept(opts);
  }
});

const expPages = { name: 'pages', url: pagesUrl };
const expCached = deriveExp('cached', expPages, cache);
const expNoadtech = deriveExp('noadtech', expCached, async (opts) => {
  const re = /adobe-privacy\/latest\/privacy.min|marketingtech|demdex.net|cookielaw.org|geolocation.onetrust.com/;
  if (opts.req.fullUrl().match(re))
    await block({ because: `Adtech`, ...opts });
});
const expNomedia = deriveExp('nomedia', expNoadtech, async (opts) => {
  await blockSuffix(opts, 'svg');
  await blockSuffix(opts, 'jpg');
  await blockSuffix(opts, 'jpeg');
  await blockSuffix(opts, 'png');
});
const expNocss = deriveExp('nocss', expNomedia, blockSuffix('css'));
const expNojs = deriveExp('nojs', expNocss, blockSuffix('js'));
const expBlockAll = deriveExp('baseline', expCached, async (opts) =>
  await block({ ...opts, reason: 'Baseline test' }));

const experiments = [
  expPages, expCached, expNoadtech,
  expNomedia, expNocss, expNojs,
  expBlockAll
];

export const gather = async () => {
  const maxWorkers = 4;
  const dir = `harmonicabsorber_${procTimeStr}`;

  const exps2 = pipe(
    enumerate(experiments),
    map(([idx, { name, ...opts }]) => [name, {
      ...opts, todo: 100, repeat: 100, idx, name,
    }]),
    dict);

  const proxychrome = await Proxychrome.new();
  proxychrome.onRequest.push(async (_, req, res, cycle) => {
    // We use the header to determine which experimental setup
    // is to be used
    const expName = req.headers['x-harmonicobserver-experiment'];
    const exp = exps2.get(expName);
    console.log("EXPERIMENT ", expName, " – ", exp, " – ", !isdef(exp));
    if (!isdef(exp))
      return;

    // Need separate caches per experiment
    const cacheDir = `${tmpdir()}/cache-${proxychrome.proxychromeId}-${expName}`

    // Make that entire throw JUMP feature work
    try {
      if (isdef(exp.intercept))
        await exp.intercept({ proxychrome, req, res, cycle, cacheDir });
    } catch (e) {
      if (e !== JUMP) {
        debug("ERROR while processing request", e);
        process.exit(1)
      }
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
