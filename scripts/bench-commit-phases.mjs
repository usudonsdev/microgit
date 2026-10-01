#!/usr/bin/env node
/**
 * 速い記録の段階ごとの時間を、ジャーナルあり・なし（ADR-0014）で比べる。最初の 20 回を除いた平均（ms）。
 * 使い方: npm run compile && node scripts/bench-commit-phases.mjs
 * 段階：journal＝ジャーナルの追記と fsync、writeObjects / writeIndex / writeRefs＝Git のファイルを書く、fsyncMs＝fsync の合計
 */
import { execFileSync } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { FastMicroCommitter } = require(path.join(ROOT, 'out', 'fastMicroCommit.js'));
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'B', GIT_AUTHOR_EMAIL: 'b@l', GIT_COMMITTER_NAME: 'B', GIT_COMMITTER_EMAIL: 'b@l' };
for (const journal of [true, false]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  execFileSync('git', ['init', '-q', '-b', 'micro-history', dir]); execFileSync('git', ['-C', dir, 'config', 'core.autocrlf', 'false']);
  for (let i = 0; i < 50; i++) { fs.mkdirSync(path.join(dir, 'src', `d${i % 5}`), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', `d${i % 5}`, `f${i}.ts`), `x${i}\n`); }
  execFileSync('git', ['-C', dir, 'add', '-A']); execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'i'], { env: ENV });
  const fc = new FastMicroCommitter(dir, () => true, { journal });
  const sum = {}; let tag = 'mb-1'; const N = 200;
  for (let n = 0; n < N; n++) {
    const rel = `src/d${n % 5}/f${(n * 7) % 50}.ts`;
    fs.appendFileSync(path.join(dir, rel), `s${n}\n`);
    const out = fc.record({ shadowRepoPath: dir, relativeFilePath: rel, currentTag: tag, message: () => `s${n}`, commitEnv: ENV });
    if (out.tag) tag = out.tag;
    if (n >= 20) for (const [k, v] of Object.entries(fc.stats.lastPhases)) sum[k] = (sum[k] ?? 0) + v;
    if (journal && n % 20 === 19) await fc.checkpoint();
  }
  const total = Object.entries(sum).filter(([k]) => !k.startsWith('fsync')).reduce((a, [, v]) => a + v, 0) / (N - 20);
  console.log(journal ? 'journal' : 'no-journal', Object.entries(sum).map(([k, v]) => `${k}:${(v / (N - 20)).toFixed(2)}`).join(' '), `total:${total.toFixed(1)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
