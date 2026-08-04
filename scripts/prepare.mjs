// `prepare` runs on `npm install`, both for direct installs (`npm i`
// in `sdk/` itself) and for file-dep consumers (`"@brass-build/client":
// "file:../sdk"`). We want one script that:
//
// 1. Skips the build when `dist/index.js` already exists. A consumer
//    that installs a prebuilt SDK should not have to re-run `tsc` on
//    every `npm install`, and an environment without a resolvable
//    `tsc` (a fresh sandbox, a CI runner that doesn't install the
//    SDK's own devDeps when pulling it as a file dep) would otherwise
//    fail the consumer's `npm install` outright.
// 2. Runs `tsc -b` from this directory when `dist/` is missing, so a
//    direct `npm install` in `sdk/` still emits the bundle.
//
// `tsc` is resolved through `node_modules/.bin/` of this package, so
// it works whether the consumer has a global `tsc` or not, as long as
// the SDK's own devDeps installed (which they will under a plain
// `npm i` in `sdk/`). When this script runs from a file-dep consumer
// install, dist/ is already present in the file: target and we exit
// before invoking tsc.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = dirname(here);
const builtEntry = join(sdkRoot, 'dist', 'index.js');

if (existsSync(builtEntry)) {
  process.exit(0);
}

const tscBin = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
const localTsc = join(sdkRoot, 'node_modules', '.bin', tscBin);
const command = existsSync(localTsc) ? localTsc : tscBin;

const result = spawnSync(command, ['-b'], { stdio: 'inherit', cwd: sdkRoot });
if (result.error || (result.status ?? 0) !== 0) {
  // Don't fail the install: a consumer who pulled the SDK as a file
  // dep without dist/ and without typescript available can still
  // import `src/` via the `files` whitelist, and the SDK's primary
  // consumption path is the prebuilt `dist/`. A loud warning here
  // lets the operator notice; a hard exit would block the whole
  // dependency install for a working setup.
  console.warn(
    '[@brass-build/client] prepare: tsc -b did not run cleanly; ' +
      'install is continuing without rebuilding dist/.',
  );
}
