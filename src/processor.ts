import { Worker } from 'node:worker_threads';
import type { Details } from './types.js';
import { CSAF_LIMITS } from './budget.js';
export interface ProcessedDetails {
  details: Details;
  fingerprint: string;
}
export class CsafProcessor {
  private worker: Worker | undefined;
  private pending:
    | {
        resolve: (result: ProcessedDetails) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private readonly timeoutMs: number;
  private readonly workerUrl: URL;
  constructor(
    timeoutMs: number = CSAF_LIMITS.timeoutMs,
    workerUrl = new URL('./csaf-worker.js', import.meta.url),
  ) {
    this.timeoutMs = timeoutMs;
    this.workerUrl = workerUrl;
  }
  process(text: string, id: string, kind: 'csaf' | 'legacy' = 'csaf'): Promise<ProcessedDetails> {
    if (this.pending) return Promise.reject(new Error('CSAF worker is busy'));
    if (Buffer.byteLength(text) > CSAF_LIMITS.inputBytes)
      return Promise.reject(new Error('CSAF input budget exceeded'));
    if (!this.worker) {
      const worker = new Worker(this.workerUrl, {
        // A file worker must not inherit CLI-only flags such as --input-type.
        execArgv: ['--enable-source-maps'],
        resourceLimits: {
          maxOldGenerationSizeMb: CSAF_LIMITS.heapMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      this.worker = worker;
      worker.on('message', (result: ProcessedDetails & { error?: string }) => {
        if (this.worker !== worker || !this.pending) return;
        if (result.error) {
          this.fail(new Error(result.error));
          return;
        }
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        worker.unref();
        pending.resolve(result);
      });
      worker.on('error', (error) => {
        if (this.worker === worker)
          this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.fail(new Error(`CSAF worker exited (${code})`));
      });
    }
    this.worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('CSAF worker timed out')), this.timeoutMs);
      this.pending = { resolve, reject, timer };
      this.worker!.postMessage({ text, id, kind });
    });
  }
  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (worker) void worker.terminate();
  }
  close(): void {
    this.fail(new Error('CSAF worker stopped'));
  }
}
