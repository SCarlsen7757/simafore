import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const image = process.argv[2] || 'siemens-board:smoke',
  platform = process.argv[3] || 'linux/amd64';
const directory = mkdtempSync(join(tmpdir(), 'siemens-smoke-'));
chmodSync(directory, 0o777);
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
let container, base;
async function start() {
  container = docker(
    'run',
    '-d',
    '--platform',
    platform,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--mount',
    `type=bind,source=${directory},target=/data`,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'POLL_ON_START=false',
    image,
  );
  base = 'http://127.0.0.1:' + docker('port', container, '8080/tcp').split(':').at(-1);
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(base + '/tv')).ok) return;
    } catch {
      /* boot */
    }
    await setTimeout(500);
  }
  throw new Error('Container failed to start');
}
try {
  await start();
  assert.match(await (await fetch(base + '/tv')).text(), /Siemens|SIEMENS/);
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(base + '/healthz')).status, 503);
  assert.equal((await fetch(base + '/source-sans-3.otf')).status, 200);
  docker(
    'exec',
    container,
    'node',
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { Store } from '/app/dist/src/db.js';
    import { CsafProcessor } from '/app/dist/src/processor.js';
    assert.equal(process.getuid(),1000);
    const processor = new CsafProcessor();
    try {
      const result = await processor.process(JSON.stringify({document:{csaf_version:'2.0',tracking:{id:'SSA-123456',current_release_date:'2026-09-14T00:00:00Z'}}}), 'SSA-123456');
      assert.equal(result.details.schemaVersion,2);
    } finally { processor.close(); }
    const s=new Store('/data/board.db');
    s.ingest([{id:'SSA-123456',feedId:'test',title:'SIMATIC smoke fixture',summary:'Synthetic',link:'https://cert-portal.siemens.com/productcert/html/ssa-123456.html',updated:1800000000,published:null}],()=>true);
    s.db.exec('DELETE FROM queue');s.setMeta({last_success:Math.floor(Date.now()/1000)});s.close();
  `,
  );
  docker('rm', '-f', container);
  container = undefined;
  await start();
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const api = await (await fetch(base + '/api/advisories')).json();
  assert.equal(api.schemaVersion, 2);
  assert.equal(api.itemCount, 1);
  assert.equal(api.items[0].id, 'SSA-123456');
  assert.match(api.contentRevision, /^[a-f0-9]{64}$/);
  console.log(platform + ': non-root image, endpoints, font and bind persistence passed');
} catch (error) {
  if (container) console.error(docker('logs', container));
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
