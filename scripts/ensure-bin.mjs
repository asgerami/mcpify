#!/usr/bin/env node
/**
 * npm 12's `npx @asgerami/wrangl …` from inside this repo shells out to a bare
 * `wrangl` command. Link a shim into node_modules/.bin so that works after build.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
if (!existsSync(cli)) process.exit(0);

const binDir = join(root, "node_modules", ".bin");
mkdirSync(binDir, { recursive: true });
const shim = join(binDir, "wrangl");
writeFileSync(
  shim,
  `#!/bin/sh\nexec node "$(dirname "$0")/../../dist/cli.js" "$@"\n`,
);
chmodSync(shim, 0o755);
