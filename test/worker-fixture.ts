import { parentPort } from 'node:worker_threads';
import { parseCsaf } from '../src/parse.js';
import { fingerprint } from '../src/fingerprint.js';
parentPort!.on('message', ({ text, id }: { text: string; id: string }) => {
  if (text === 'crash') process.exit(1);
  if (text === 'hang') {
    while (true) {
      /* intentionally stalled worker */
    }
  }
  const details = parseCsaf(JSON.parse(text) as unknown, id);
  parentPort!.postMessage({ details, fingerprint: fingerprint(details) });
});
