#!/usr/bin/env node
// Release pipeline for WrongPort:
//   1. preflight (clean git tree, on main)
//   2. verify gate (typecheck + tests + 100% coverage + build)
//   3. version bump kept in sync across package.json, package-lock.json and
//      the CLI banner in src/cli/index.ts
//   4. release commit + annotated tag (branch and tag are pushed only --push)
//
// Usage:
//   npm run release                 # patch bump
//   npm run release -- minor        # major | minor | patch
//   npm run release -- --dry-run    # plan only, writes nothing
//   npm run release -- --push minor # bump, tag and push
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const push = args.includes('--push');
const part = args.find((argument) => ['major', 'minor', 'patch'].includes(argument)) ?? 'patch';

const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`→ ${message}`);

const git = (gitArgs, { capture = false, allowFailure = false } = {}) => {
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    if (allowFailure) return capture ? '' : undefined;
    die(`git ${gitArgs.join(' ')} failed:\n${result.stderr}`);
  }
  return capture ? result.stdout.trim() : undefined;
};

const npm = (npmArgs) => {
  // Windows cannot spawn npm.cmd without a shell (Node >= 18.20 returns
  // EINVAL), and .cmd shims differ per installation. When running under npm
  // (the normal `npm run release` path) reuse the npm JS entry point that is
  // already executing this script; otherwise fall back to a shelled .cmd.
  const execPath = process.env.npm_execpath;
  const result =
    execPath !== undefined && execPath.endsWith('.js')
      ? spawnSync(process.execPath, [execPath, ...npmArgs], { cwd: root, stdio: 'inherit' })
      : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
  if (result.error !== undefined) {
    die(`npm ${npmArgs.join(' ')} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) die(`npm ${npmArgs.join(' ')} failed`);
};

const bumpVersion = (version, part) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) die(`cannot parse version "${version}"`);
  let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (part === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
};

// ── 1. preflight ─────────────────────────────────────────────────────────────
git(['rev-parse', '--is-inside-work-tree']);
const status = git(['status', '--porcelain'], { capture: true });
if (status.length > 0) die(`working tree is not clean:\n${status}`);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
if (branch !== 'main' && !dryRun) {
  die(`refusing to release from branch "${branch}" — switch to main first`);
}
// A repo without any tags makes `git describe` exit non-zero — that is fine,
// it just means there is no previous tag to show.
const lastTag = git(['describe', '--tags', '--abbrev=0'], { capture: true, allowFailure: true });
say(`preflight ok (branch: ${branch}, last tag: ${lastTag || 'none'})`);

// ── 2. verify gate ───────────────────────────────────────────────────────────
say('running verify (typecheck + tests + 100% coverage gate + build)');
npm(['run', 'verify']);

// ── 3. version bump ──────────────────────────────────────────────────────────
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const cliPath = path.join(root, 'src', 'cli', 'index.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bumpVersion(pkg.version, part);

const cliSource = readFileSync(cliPath, 'utf8');
const versionCall = `.version('${pkg.version}')`;
if (!cliSource.includes(versionCall)) {
  die(`src/cli/index.ts does not contain ${versionCall} — keep the CLI banner in sync`);
}
const nextCliSource = cliSource.replace(versionCall, `.version('${next}')`);

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
if (lock.packages !== undefined && lock.packages[''] !== undefined) {
  lock.packages[''].version = next;
}

say(`version ${pkg.version} → ${next} (${part})`);

// ── 4. write, commit, tag ────────────────────────────────────────────────────
if (dryRun) {
  say('dry run — nothing written, no commit, no tag');
} else {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(cliPath, nextCliSource);
  git(['add', 'package.json', 'package-lock.json', 'src/cli/index.ts']);
  git(['commit', '-m', `chore(release): v${next}`]);
  git(['tag', `v${next}`]);
  say(`committed and tagged v${next}`);
  if (push) {
    git(['push']);
    git(['push', 'origin', `v${next}`]);
    say('pushed branch and tag');
  } else {
    say('not pushing — re-run with --push to publish the branch and tag');
  }
}
console.log(`✓ release ${dryRun ? 'plan' : 'complete'}: v${next}`);
