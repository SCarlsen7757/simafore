import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const IMAGE = 'ghcr.io/scarlsen7757/siemens-board';
// SemVer 2.0, including the ban on leading zeroes in numeric prerelease IDs.
const NUMBER = '(0|[1-9][0-9]*)';
const PRE = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(
  `^v${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

export function releaseTags(ref, sha) {
  const match = SEMVER.exec(ref || '');
  if (!match) throw new Error('Release tag must be v followed by a valid SemVer 2.0 version');
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Expected a full commit SHA');
  const version = ref.slice(1).replace('+', '_');
  if (version.length > 128) throw new Error('Version exceeds the Docker tag length limit');
  const tags = [version, `sha-${sha}`];
  if (!match[4]) tags.push(`${match[1]}.${match[2]}`, match[1], 'latest');
  return tags.map((tag) => `${IMAGE}:${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tags = releaseTags(process.env.GITHUB_REF_NAME, process.env.GITHUB_SHA);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tags<<RELEASE_TAGS\n${tags.join('\n')}\nRELEASE_TAGS\n`,
    );
  }
  console.log(tags.join('\n'));
}
