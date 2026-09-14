import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseTags } from './release-tags.mjs';

const sha = 'a'.repeat(40);
const suffixes = (ref) => releaseTags(ref, sha).map((tag) => tag.split(':')[1]);

test('stable releases receive explicit, SHA and stable aliases', () => {
  assert.deepEqual(suffixes('v1.2.3'), ['1.2.3', `sha-${sha}`, '1.2', '1', 'latest']);
});
test('prereleases never move stable aliases', () => {
  for (const version of ['1.2.3-rc.1', '0.1.0-0', '1.0.0-01a']) {
    assert.deepEqual(suffixes(`v${version}`), [version, `sha-${sha}`]);
  }
});
test('build metadata is preserved in a legal Docker tag', () => {
  assert.equal(suffixes('v1.2.3+build.01')[0], '1.2.3_build.01');
  assert.equal(suffixes('v1.2.3-rc.1+build.01').length, 2);
});
test('rejects malformed, unsafe and overlong versions and commit IDs', () => {
  for (const ref of [
    'main',
    '1.2.3',
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2',
    'v1.2.3-01',
    'v1.2.3-rc..1',
    'v1.2.3+',
    'v1.2.3\nlatest',
    `v1.2.3-${'a'.repeat(130)}`,
  ]) {
    assert.throws(() => releaseTags(ref, sha), undefined, ref);
  }
  assert.throws(() => releaseTags('v1.2.3', 'not-a-sha'));
});
