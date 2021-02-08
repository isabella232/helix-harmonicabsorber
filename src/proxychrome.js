import chromeLauncher from 'chrome-launcher';
import hoxy from 'hoxy';
import { createWriteStream } from 'fs';
import { readFile } from 'fs/promises';
import { each, concat } from 'ferrum';
import { v4 as uuidgen } from 'uuid';
import { rapply } from './ferrumpp.js';
import { AsyncCls, openReadStream, writeFile } from './asyncio.js';
import { cakey, cacert, tmpdir } from './settings.js';
import { base64, debug } from './stuff.js';

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
    this.proxy.intercept('request', (...args) => this._interceptReq(...args));
    this.proxy.intercept('response', (...args) => this._interceptResp(...args));
  }

  async _interceptReq(req, resp, cycle) {
    req.onResponse = [];
    each(this.onRequest, rapply([this, req, resp, cycle]));
  }

  async _interceptResp(req, resp, cycle) {
    const handlers = concat(req.onResponse, this.onResponse);
    each(handlers, rapply([this, req, resp, cycle]));
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

/// Intercept the hoxy "response" event for this request object
/// HoxyRequest => Promise
export const waitResponse = (req) => new Promise(res => req.onResponse.push(res));

/// Helper to cache the request and serve from disk
export const cacheRequest = async (proxychrome, req, resp, cycle, opts = {}) => {
  const {
    cacheDir = `${tmpdir()}/cache-${proxychrome.proxychromeId}`
  } = opts;

  const key = `${req.method} ${req.fullUrl()}`;
  const file = `${cacheDir}/${base64(key)}`;
  const metaFile = `${file}.meta.json`;

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

  debug("CACHE MISS", req.key);
  await waitResponse(req);
  await writeFile(metaFile, JSON.stringify({ // & create dir
      headers: resp.headers,
      statusCode: resp.statusCode,
  }));
  resp.tee(createWriteStream(file));
};
