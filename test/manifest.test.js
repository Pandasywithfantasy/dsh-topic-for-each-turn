import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// DSH rejects an installation whose `engines.dsh` or dsh peer ranges exclude the
// running version, and the rejection blocks every install until the user grants an
// exact-version exemption. Pinning `0.2.0-rc.2` exactly made a 0.2.1-rc.1 upgrade
// look like a broken plugin, so the ranges must admit the whole 0.2 line.
test('declared DSH ranges cover the 0.2 line and stay open to its patches', async () => {
  const engines = manifest.engines?.dsh;
  assert.equal(engines, '>=0.2.0-rc.2 <0.3.0', 'engines.dsh decides the check and must name the supported minor');
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-home-paths']) {
    assert.equal(manifest.peerDependencies[name], engines, `${name} must track engines.dsh so the two cannot disagree`);
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.4');

  // The project keeps zero build dependencies, so check the range with the same
  // comparator rules the runtime applies instead of importing semver.
  const satisfies = (version, range) => {
    const parse = value => {
      const [, major, minor, patch, pre] = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
      return { major: +major, minor: +minor, patch: +patch, pre };
    };
    for (const clause of range.split(/\s+/)) {
      if (clause.startsWith('>=')) {
        const bound = parse(clause.slice(2));
        const subject = parse(version);
        const order = subject.major - bound.major || subject.minor - bound.minor || subject.patch - bound.patch;
        // A prerelease never precedes its own release: 0.2.1-rc.1 satisfies >=0.2.0-rc.2.
        if (order < 0) return false;
        if (order === 0 && subject.pre !== undefined && bound.pre === undefined) return false;
      } else if (clause.startsWith('<')) {
        const bound = parse(clause.slice(1));
        const subject = parse(version);
        const order = subject.major - bound.major || subject.minor - bound.minor || subject.patch - bound.patch;
        // `<0.3.0` excludes 0.3.0 itself but not 0.3.0-rc.1, which is what semver's
        // prerelease rule already does; every 0.3 prerelease sorts below 0.3.0.
        if (order > 0) return false;
        if (order === 0 && subject.pre === undefined) return false;
      }
    }
    return true;
  };
  assert.equal(satisfies('0.2.0-rc.2', engines), true);
  assert.equal(satisfies('0.2.1-rc.1', engines), true);
  assert.equal(satisfies('0.2.1', engines), true);
  assert.equal(satisfies('0.3.0', engines), false, 'a new minor needs an explicit decision');
  assert.equal(satisfies('0.1.6-alpha.2', engines), false);
});

test('the bundle patch registers the plugin exactly once', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map(m => m[1]);
  assert.deepEqual(ids, ['topic-for-each-turn']);
  assert.match(patch, /^\s*name:\s*dsh-topic-for-each-turn$/m);
  // The package owns the single insert; a profile copy is what made DSH report
  // `duplicate loader entry id` and roll the upgrade back.
  assert.equal([...patch.matchAll(/^\s*-\s*insert:/gm)].length, 1);
});

// Publishing guard: the repository must stay environment-neutral, so a local
// iteration cannot silently re-add the author's provider, model, or credentials
// code. Personal routes belong in the desktop profile patch, not here.
test('the repository ships no personal route, credential UI, or machine path', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /^\s*provider:\s*''$/m);
  assert.match(patch, /^\s*model:\s*''$/m);
  for (const file of ['../src/keys.js', '../src/key-panel.js', '../scripts/check-model.js']) {
    await assert.rejects(readFile(new URL(file, import.meta.url)), /ENOENT/);
  }
  const host = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /keys-state|keys-add|key-pool/);
  const tracked = ['../src/index.js', '../src/model-settings.js', '../src/settings-panel.js', '../src/batch-panel.js', '../README.md'];
  for (const file of tracked) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/]|thinkbook-cpa|gemini-3\./, `${file} must not embed machine paths or the author's route`);
  }
});

test('the version is a single source shared by both halves', async () => {
  const host = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const hostVersion = host.match(/HOST_VERSION = '([^']+)'/)[1];
  const clientVersion = client.match(/CLIENT_VERSION = '([^']+)'/)[1];
  assert.equal(hostVersion, manifest.version);
  assert.equal(clientVersion, manifest.version);
});
