import process from 'process';
import minimist from 'minimist';
import { isdef, type } from "ferrum";
import { spawn } from './asyncio.js';
import { debug } from './stuff.js';
import { cakeyfile, cacertfile, } from './settings.js';
import { gather } from './gather.js';
import { report } from './report.js';

/// Create the mock certificate authority used to intercept ssl traffic
const makeca = async () => {
  await spawn('openssl', 'genrsa',
    '-out', cakeyfile, '4096').onExit;
  await spawn('openssl', 'req', '-x509', '-new', '-nodes',
    '-key', cakeyfile,
    '-out', cacertfile,
    '-days', '10',
    '-subj', '/C=US/ST=Utah/L=Provo/O=DO NOT TRUST Helix Dummy Signing Authority DO NOT TRUST/CN=project-helix.io').onExit;
};
const main = async (...rawArgs) => {
  const cmds = {
    makeca, gather, report,
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
    process.on('uncaughtException', (err, origin) => debug('ERROR', err, origin));
    process.on('unhandeledRejecion', (err) => debug('REJECTION', err));
    await main(...process.argv.slice(2));
    process.exit();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};

init();
