export const CSAF_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  relationships: 250000,
  operations: 2000000,
  textBytes: 64 * 1024,
  timeoutMs: 5000,
  heapMb: 128,
} as const;

export class Budget {
  private operations = 0;
  private bytes = 0;
  private relationships = 0;
  step(n = 1): void {
    this.operations += n;
    if (this.operations > CSAF_LIMITS.operations)
      throw new Error('CSAF processing budget exceeded');
  }
  relation(): void {
    this.step();
    if (++this.relationships > CSAF_LIMITS.relationships)
      throw new Error('CSAF relationship budget exceeded');
  }
  add(value: unknown): void {
    this.bytes += jsonBytes(value, CSAF_LIMITS.outputBytes - this.bytes);
    if (this.bytes > CSAF_LIMITS.outputBytes) throw new Error('CSAF output budget exceeded');
  }
}

// Count JSON-escaped UTF-8 bytes before serializing or duplicating a structure.
// Iterative traversal also rejects pathological nesting without recursive stack growth.
export function jsonBytes(value: unknown, max = CSAF_LIMITS.outputBytes): number {
  let bytes = 0,
    operations = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const entry = stack.pop()!;
    if (++operations > CSAF_LIMITS.operations || entry.depth > 64)
      throw new Error('CSAF processing budget exceeded');
    const v = entry.value;
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x) => ['', x] as const) : Object.entries(v);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        if (!Array.isArray(v)) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    } else bytes += Buffer.byteLength(JSON.stringify(v) ?? 'null');
    if (bytes > max) throw new Error('CSAF output budget exceeded');
  }
  return bytes;
}
