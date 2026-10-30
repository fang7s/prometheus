#!/usr/bin/env node
/**
 * Cross-platform `node --check` runner.
 *
 * `npm run test:syntax` used to shell out to unix `find … -exec`, which fails on
 * Windows. This walks the repo and syntax-checks every .js file with the running
 * Node binary instead.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "logs", ".claude"]);

function collect(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), files);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = collect(ROOT).sort();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(ROOT, file),
      output: (result.stderr || result.stdout || "").trim(),
    });
  }
}

if (failures.length) {
  console.error(`✗ Syntax check failed for ${failures.length}/${files.length} files\n`);
  for (const failure of failures) console.error(`${failure.file}\n${failure.output}\n`);
  process.exit(1);
}

console.log(`✓ Syntax OK — ${files.length} files checked`);
