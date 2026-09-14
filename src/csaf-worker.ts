import { parentPort } from 'node:worker_threads';
import { parseCsaf } from './parse.js';
import { compactLegacy } from './compact.js';
import { fingerprint } from './fingerprint.js';
import { CSAF_LIMITS, jsonBytes } from './budget.js';
parentPort!.on('message', (job: { text: string; id: string; kind: 'csaf' | 'legacy' }) => {
  try {
    if (Buffer.byteLength(job.text) > CSAF_LIMITS.inputBytes)
      throw new Error('CSAF input budget exceeded');
    const raw = JSON.parse(job.text) as unknown;
    const details = job.kind === 'legacy' ? compactLegacy(raw) : parseCsaf(raw, job.id);
    jsonBytes(details);
    parentPort!.postMessage({ details, fingerprint: fingerprint(details) });
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : 'CSAF processing failed',
    });
  }
});
