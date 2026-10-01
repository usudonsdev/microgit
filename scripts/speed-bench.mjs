#!/usr/bin/env node
/**
 * MicroGit 速度ベンチ（Overlay + シャドウ Git 操作）
 * 使い方: node scripts/speed-bench.mjs
 * 環境変数:
 *   FILES=200   初期ファイル数
 *   COMMITS=30  連続保存（レイヤ）数
 *   SWITCHES=20 ブランチ切替（checkout）回数
 */
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const {
  ensureOverlayDirs,
  expandViewAfterExport,
  checkoutLayers,
  layerDir,
  isViewReady,
  syncMergeToWorkspace,
  addWhiteout,
} = require(path.join(ROOT, 'out', 'overlay.js'));

const FILES = Number(process.env.FILES || 200);
const COMMITS = Number(process.env.COMMITS || 30);
const SWITCHES = Number(process.env.SWITCHES || 20);

function hr() {
  return process.hrtime.bigint();
}
function ms(start) {
  return Number(hr() - start) / 1e6;
}
function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}
function p95(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function fmt(n) {
  return `${n.toFixed(2)} ms`;
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Bench',
      GIT_AUTHOR_EMAIL: 'bench@local',
      GIT_COMMITTER_NAME: 'Bench',
      GIT_COMMITTER_EMAIL: 'bench@local',
    },
  }).toString();
}

function hashHex(n = 20) {
  return createHash('sha1').update(randomBytes(32)).update(String(n)).digest('hex');
}

function writeLayer(paths, hash, files) {
  const dir = layerDir(paths, hash);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) {
      // レイヤ形式 v2: whiteout は層の外のメタデータ（layers/<hash>.json）に持つ
      addWhiteout(dir, rel);
      continue;
    }
    const out = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
}

console.log('=== MicroGit speed bench ===');
console.log(`platform=${process.platform} FILES=${FILES} COMMITS=${COMMITS} SWITCHES=${SWITCHES}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-bench-'));
const workspace = path.join(tmp, 'ws');
const shadow = path.join(workspace, '.microgit_shadow');
fs.mkdirSync(shadow, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

// --- 1) シャドウ Git: 連続マイクロコミット ---
runGit(shadow, ['init', '-b', 'micro-history']);
const seedBody = 'x'.repeat(256);
const commitTimes = [];
let parent = '';

const tSeed = hr();
for (let i = 0; i < FILES; i++) {
  const rel = `src/f${String(i).padStart(4, '0')}.txt`;
  const abs = path.join(shadow, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${seedBody}\n# ${i}\n`);
}
runGit(shadow, ['add', '-A']);
const tree0 = runGit(shadow, ['write-tree']).trim();
parent = runGit(shadow, ['commit-tree', tree0, '-m', 'seed']).trim();
runGit(shadow, ['update-ref', 'refs/heads/micro-history', parent]);
runGit(shadow, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
const seedMs = ms(tSeed);

for (let c = 0; c < COMMITS; c++) {
  const idx = c % FILES;
  const rel = `src/f${String(idx).padStart(4, '0')}.txt`;
  const abs = path.join(shadow, ...rel.split('/'));
  fs.writeFileSync(abs, `${seedBody}\n# ${idx}\ncommit=${c}\n`);
  const t0 = hr();
  runGit(shadow, ['add', '--', rel]);
  const tree = runGit(shadow, ['write-tree']).trim();
  // tip 同一 tree なら commit 省略（本番の early-exit）
  const headTree = runGit(shadow, ['rev-parse', 'HEAD^{tree}']).trim();
  if (headTree === tree) {
    commitTimes.push(ms(t0));
    continue;
  }
  const hash = runGit(shadow, ['commit-tree', tree, '-p', parent, '-m', `micro ${c}`]).trim();
  runGit(shadow, ['update-ref', 'refs/heads/micro-history', hash]);
  parent = hash;
  commitTimes.push(ms(t0));
}

// 同一内容の再保存（early-exit）を別計測
const noopTimes = [];
const lastRel = `src/f${String(0).padStart(4, '0')}.txt`;
for (let i = 0; i < 10; i++) {
  const t0 = hr();
  runGit(shadow, ['add', '--', lastRel]);
  const tree = runGit(shadow, ['write-tree']).trim();
  const headTree = runGit(shadow, ['rev-parse', 'HEAD^{tree}']).trim();
  if (headTree !== tree) throw new Error('expected noop tree match');
  noopTimes.push(ms(t0));
}

console.log('\n[1] Shadow git (commit-tree path)');
console.log(`  seed ${FILES} files: ${fmt(seedMs)}`);
console.log(`  per-save avg: ${fmt(avg(commitTimes))}  p95: ${fmt(p95(commitTimes))}  min: ${fmt(Math.min(...commitTimes))}  max: ${fmt(Math.max(...commitTimes))}`);
console.log(`  noop/unchanged avg: ${fmt(avg(noopTimes))}  p95: ${fmt(p95(noopTimes))}`);

// --- 2) Overlay: 初回展開 / 増分 / キャッシュ切替 ---
const paths = ensureOverlayDirs(workspace);
const hashes = [];
const expandFirst = [];
const expandInc = [];

// base layer = all files
const baseHash = hashHex(0);
const baseFiles = {};
for (let i = 0; i < FILES; i++) {
  baseFiles[`src/f${String(i).padStart(4, '0')}.txt`] = `${seedBody}\n# ${i}\n`;
}
writeLayer(paths, baseHash, baseFiles);
const tBase = hr();
const m0 = expandViewAfterExport(paths, baseHash, undefined);
expandFirst.push(ms(tBase));
hashes.push(baseHash);
if (!isViewReady(paths, baseHash)) throw new Error('base view missing');

let prev = baseHash;
for (let c = 1; c <= COMMITS; c++) {
  const h = hashHex(c);
  const idx = c % FILES;
  const rel = `src/f${String(idx).padStart(4, '0')}.txt`;
  writeLayer(paths, h, { [rel]: `${seedBody}\n# ${idx}\ncommit=${c}\n` });
  const t0 = hr();
  const method = expandViewAfterExport(paths, h, prev);
  const elapsed = ms(t0);
  if (method === 'incremental') expandInc.push(elapsed);
  else expandFirst.push(elapsed);
  hashes.push(h);
  prev = h;
}

const checkoutCold = [];
const checkoutHot = [];
// cold: alternate tips (simulate branch switch)
const tipA = hashes[Math.floor(hashes.length / 2)];
const tipB = hashes[hashes.length - 1];
const pathA = hashes.slice(0, hashes.indexOf(tipA) + 1);
const pathB = hashes;

for (let i = 0; i < SWITCHES; i++) {
  const useA = i % 2 === 0;
  const layerPath = useA ? pathA : pathB;
  const tag = useA ? 'mb-1' : 'mb-2';
  const t0 = hr();
  const r = checkoutLayers(paths, layerPath, tag);
  const elapsed = ms(t0);
  if (r.appliedLayers === 0 && r.method === 'cached-view') checkoutHot.push(elapsed);
  else checkoutCold.push(elapsed);
}

console.log('\n[2] Overlay expand + checkout');
console.log(`  first expand (full): ${fmt(avg(expandFirst))} (n=${expandFirst.length})`);
console.log(`  incremental expand avg: ${fmt(avg(expandInc))}  p95: ${fmt(p95(expandInc))}  (n=${expandInc.length})`);
console.log(`  checkout cold-ish avg: ${fmt(avg(checkoutCold))}  p95: ${fmt(p95(checkoutCold))}  (n=${checkoutCold.length})`);
console.log(`  checkout cached avg:   ${fmt(avg(checkoutHot))}  p95: ${fmt(p95(checkoutHot))}  (n=${checkoutHot.length})`);

// --- 3) merge → workspace sync ---
const syncTimes = [];
checkoutLayers(paths, pathB, 'mb-2');
for (let i = 0; i < 5; i++) {
  // flip one file in merge to force some writes on first iter only; still measure skip path
  const t0 = hr();
  const { written, deleted, skipped } = syncMergeToWorkspace(
    workspace,
    paths,
    (rel) => !String(rel).includes('..'),
    (p) => String(p).includes('.microgit_'),
    undefined,
  );
  syncTimes.push({ ms: ms(t0), written: written.length, deleted: deleted.length, skipped });
}
console.log('\n[3] syncMergeToWorkspace');
for (const [i, s] of syncTimes.entries()) {
  console.log(`  #${i + 1}: ${fmt(s.ms)}  written=${s.written} deleted=${s.deleted} skipped=${s.skipped}`);
}

console.log(`\ntmp: ${tmp}`);
console.log('done.');
