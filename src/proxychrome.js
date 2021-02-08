import chromeLauncher from 'chrome-launcher';
import hoxy from 'hoxy';
import { readFile } from 'fs/promises';
import { v4 as uuidgen } from 'uuid';
import { each, concat, exec } from 'ferrum';
import { rapply } from './ferrumpp.js';
import { AsyncCls, openReadStream, writeFile, openWriteStream } from './asyncio.js';
import { cakey, cacert, tmpdir } from './settings.js';
import { debug, sha256 } from './stuff.js';

const { assign } = Object;

/// Starts a chrome instance and allows us to filter the requests
export class Proxychrome extends AsyncCls {
  async _init(opts = {}) {
    let {
      port = 5050,
      key = cakey,
      cert = cacert,
      proxychromeId = uuidgen(),
    } = opts;

    // Local variables
    assign(this, {
      proxychromeId, port,
      onRequest: [], // Add request handlers here
      onResponse: [], // Add response handlers here
    });

    // Load data
    const proxyOpts = { certAuthority: { key, cert } };
    this.proxy = hoxy.createServer(proxyOpts).listen(port);
    this.proxy.intercept('request', async (...args) => await this._interceptReq(...args));
    this.proxy.intercept('response', async (...args) => await this._interceptResp(...args));
  }

  async _interceptReq(req, resp, cycle) {
    req.onResponse = [];
    for (const fn of this.onRequest)
      await fn(this, req, resp, cycle);
  }

  async _interceptResp(req, resp, cycle) {
    for (const fn of concat(req.onResponse, this.onResponse))
      await fn(this, req, resp, cycle);
  }


    // Launch chrome
  launchChrome(opts = {}) {
    const { headless = true } = opts;
    return chromeLauncher.launch({
      chromeFlags: [
        ...(headless ? ['--headless'] : []),
        `--proxy-server=http://localhost:${this.port}`,
        `--proxy-bypass-list=<-loopback>;<-local>`,
        `--ignore-certificate-errors`,
      ]
    });
  }
}

/// Helper to cache the request and serve from disk
export const cacheRequest = async (proxychrome, req, resp, cycle, opts = {}) => {
  const {
    cacheDir = `${tmpdir()}/cache-${proxychrome.proxychromeId}`
  } = opts;

  const key = `${req.method} ${req.fullUrl()}`;
  const file = `${cacheDir}/${sha256(key)}`;
  const metaFile = `${file}.meta.json`;
  console.log("CACHE", { key, file, metaFile })

  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    resp._source = await openReadStream(file);
    resp.statusCode = meta.statusCode;
    each(meta.headers || {}, ([k, v]) => {
      resp.headers[k] = v;
    });
    return;

  } catch (e) {
    if (e.code !== 'ENOENT') {
      resp.statusCode = 500;
      console.error(`${e.key}:\n\tException while serving file: ${req.hostedFile}:`, e);
      return;
    }
  }

  debug("CACHE MISS", key);
  req.onResponse.push(async () => { // fork
    resp.tee(await openWriteStream(file));
    await writeFile(metaFile, JSON.stringify({ // & create dir
        headers: resp.headers,
        statusCode: resp.statusCode,
    }));
  });
};
