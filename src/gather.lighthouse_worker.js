import assert from 'assert';
import process from 'process';
import lighthouse from 'lighthouse';
import { eq } from 'ferrum';
import { writeFile, BufferedChannel, sleep } from './asyncio.js';

const main = async () => {
  const msgs = BufferedChannel.new();
  let ready = false;
  process.on('message', (m) => {
    if (eq(m, { what: 'ready' })) {
      ready = true;
    } else {
      msgs.enqueue(m);
    }
  });

  // For some reason the process IPC is brittle as hell at startup;
  // to avoid a sleep() in the dark, I created this handshake…
  while (true) {
    process.send({ what: 'ready' });
    if (ready)
      break;
    await sleep(10);
  }

  console.log("STARTED WORKDER!!", process.send);
  while (true) {
    const { jobId, what, out, port, url, extraHeaders } = await msgs.dequeue();
    console.log("GOT MSG!", { what, jobId });
    if (what === 'quit')
      break;

    assert(what === 'lighthouse');

    const { report, lhr, artifacts } = await lighthouse(url, {
      logLevel: 'error',
      output: 'html',
      onlyCategories: ['performance'],
      port, extraHeaders,
    });

    await writeFile(`${out}/report.json`, JSON.stringify(lhr));
    await writeFile(`${out}/artifacts.json`, JSON.stringify(artifacts));
    await writeFile(`${out}/report.html`, report);

    process.send({ what: 'lighthouse_done', jobId });
  }
};

main();
