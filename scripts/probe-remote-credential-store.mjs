#!/usr/bin/env node
/** B2 evidence tooling: run the real provider against a fresh temporary store only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

function base32(input) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, output = '';
  for (const byte of Buffer.from(input, 'utf8')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

async function load(entry) {
  const packageFile = resolve(dirname(entry), '..', 'package.json');
  const require = createRequire(packageFile);
  const provider = await import(pathToFileURL(entry).href);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { credentialKey } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials')).href);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(metadata.name, '@deepseek-ai/dsh-credentials-local');
  return { provider, Context, credentialKey, metadata };
}

async function boot(api, file) {
  const context = new api.Context();
  const fiber = context.plugin(api.provider.LocalCredentialProvider, {
    path: file, dshHome: dirname(file), watch: false,
  });
  await fiber;
  return { service: context.credentials, dispose: () => fiber.dispose() };
}

const args = process.argv.slice(2);
if (args[0] === '--worker') {
  const entry = resolve(args[1]);
  const file = resolve(args[2]);
  const api = await load(entry);
  const instance = await boot(api, file);
  try {
    for (let index = 0; index < 2; index++) {
      await instance.service.modifyRecord(api.credentialKey('dsh-plugin-git', 'b2-counter'), async current => ({
        kind: 'grant', payload: { count: (current?.payload?.count ?? 0) + 1 },
      }));
    }
  } finally { await instance.dispose(); }
} else {
  const providerIndex = args.indexOf('--provider');
  const outputIndex = args.indexOf('--output');
  assert(providerIndex >= 0 && args[providerIndex + 1], 'Pass --provider <real published lib/index.js>');
  assert(outputIndex >= 0 && args[outputIndex + 1], 'Pass --output <evidence.json>');
  const entry = resolve(args[providerIndex + 1]);
  const output = resolve(args[outputIndex + 1]);
  const work = await mkdtemp(join(tmpdir(), 'dsh-git-b2-store-'));
  const file = join(work, '.credentials.yaml');
  const previousCwd = process.cwd();
  process.chdir(work);
  const checks = [];
  const instances = [];
  try {
    const api = await load(entry);
    const baseline = 'https://git.example.com/';
    const instanceUrl = baseline + 'a'.repeat(512 - Buffer.byteLength(baseline));
    const key = api.credentialKey('dsh-plugin-git', 'gl-' + base32(instanceUrl));
    assert.equal(Buffer.byteLength(instanceUrl), 512);
    assert.equal(key.length, 838);
    checks.push('canonical-url-512-bytes-and-key-838-characters');
    const grant = { kind: 'grant', payload: {
      v: 2, provider: 'gitlab', instance: instanceUrl, clientId: 'b2-synthetic-app',
      state: 'authenticated', revision: 'synthetic-1', accessToken: 'B2-TEST-NOT-A-REAL-TOKEN',
      refreshToken: 'B2-TEST-NOT-A-REAL-REFRESH-TOKEN',
    } };
    let active = await boot(api, file); instances.push(active);
    await active.service.modifyRecord(key, async () => grant);
    assert.deepEqual(await active.service.readRecord(key), grant);
    checks.push('real-provider-write-read-equality');
    assert.deepEqual(await active.service.describeRecord(key), { configured: true, kind: 'grant', writable: true });
    checks.push('wire-safe-describe');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      checks.push('owner-only-file-mode');
    }
    const sibling = api.credentialKey('dsh-plugin-git', 'github-com');
    await active.service.modifyRecord(sibling, async () => ({ kind: 'grant', payload: { sentinel: 'synthetic-sibling' } }));
    await active.service.modifyRecord(key, async () => undefined);
    assert.deepEqual(await active.service.readRecord(key), grant);
    checks.push('undefined-mutation-preserves-record');
    await active.dispose(); instances.pop();
    active = await boot(api, file); instances.push(active);
    assert.deepEqual(await active.service.readRecord(key), grant);
    checks.push('fresh-provider-restart-persistence');
    const retired = { kind: 'grant', payload: { v: 2, provider: 'gitlab', instance: instanceUrl, state: 'signed-out', revision: 'synthetic-2', retired: true } };
    await active.service.modifyRecord(key, async current => {
      assert.equal(current.payload.revision, 'synthetic-1');
      return retired;
    });
    assert.deepEqual(await active.service.readRecord(key), retired);
    assert.equal((await active.service.readRecord(sibling)).payload.sentinel, 'synthetic-sibling');
    assert(!(await readFile(file, 'utf8')).includes(grant.payload.accessToken));
    assert(!(await readFile(file, 'utf8')).includes(grant.payload.refreshToken));
    checks.push('retired-payload-removes-synthetic-secrets-preserves-sibling');
    await active.dispose(); instances.pop();
    // Four distinct OS processes use the published provider's own writer lock.
    const childEnv = { PATH: process.env.PATH ?? '', TMPDIR: work };
    await Promise.all(Array.from({ length: 4 }, () => new Promise((accept, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', entry, file], {
        cwd: work, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? accept() : reject(new Error('isolated worker failed: ' + diagnostic)));
    })));
    active = await boot(api, file); instances.push(active);
    assert.equal((await active.service.readRecord(api.credentialKey('dsh-plugin-git', 'b2-counter'))).payload.count, 8);
    assert.deepEqual(await active.service.readRecord(key), retired);
    checks.push('four-process-eight-updates-without-lost-writes');
    await active.service.deleteRecord(key);
    assert.equal(await active.service.readRecord(key), undefined);
    await active.dispose(); instances.pop();
    active = await boot(api, file); instances.push(active);
    assert.equal(await active.service.readRecord(key), undefined);
    checks.push('unconditional-delete-persists-across-restart');
    const evidence = {
      scope: 'isolated real file-backed provider, synthetic payloads only',
      provider: api.metadata.name, version: api.metadata.version,
      providerEntrySha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
      node: process.version, platform: process.platform, arch: process.arch,
      canonicalUrlBytes: 512, recordKeyCharacters: 838, checks, passed: true,
      limits: ['No user credential files or GitLab accounts accessed.', 'Does not prove other providers, operating systems, or plugin OAuth behavior.'],
    };
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ version: evidence.version, passed: true, checks: checks.length, recordKeyCharacters: key.length }));
  } finally {
    for (const instance of instances.reverse()) await instance.dispose();
    process.chdir(previousCwd);
    await rm(work, { recursive: true, force: true });
  }
}
