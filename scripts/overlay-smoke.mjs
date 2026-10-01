#!/usr/bin/env node
/**
 * Node.js 仮想 Overlay（src/overlay.ts）のスモークテスト。
 * 使い方: npm run compile && node scripts/overlay-smoke.mjs   （npm run test:overlay でも同じ）
 *
 * 1〜3 は以前からの確認（ビューの再利用、兄弟の枝の分離）。4 以降は #21 で直した点の回帰テスト:
 *   4. レイヤ形式 v2: `.wh.` で始まる普通のファイルが消えない（N-5）
 *   5. ファイル → ディレクトリ／ディレクトリ → ファイルの置き換え（N-3・N-4）。whiteout の順番に依存しない
 *   6. 実際の Git で exportCommitLayer: 日本語のパス（Git の既定 core.quotepath=true を強制、N-6）、
 *      1 MiB を超えるファイル、ファイル ⇔ ディレクトリの置き換え
 *   7. 形式 v1 のキャッシュを見つけたら捨てて作り直す
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const o = require(path.join(ROOT, 'out', 'overlay.js'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-overlay-'));

/** 形式 v2 の層を手で作る（body が null なら whiteout） */
function writeLayer(paths, hash, files) {
  const dir = o.layerDir(paths, hash);
  fs.mkdirSync(dir, { recursive: true });
  const whiteouts = [];
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) { whiteouts.push(rel); continue; }
    const out = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
  o.writeLayerMeta(dir, whiteouts);
}

// ---------------------------------------------------------------- 1〜3
console.log('1-3. ビューの再利用と兄弟の枝の分離');
{
  const paths = o.ensureOverlayDirs(path.join(tmpRoot, 'basic'));
  const [h1, h2, h3] = ['a', 'b', 'c'].map((c) => c.repeat(40));
  writeLayer(paths, h1, { 'keep.txt': 'KEEP', 'src/a.txt': 'A1' });
  o.expandViewAfterExport(paths, h1, undefined);
  writeLayer(paths, h2, { 'src/a.txt': 'A2', 'keep.txt': null });
  check('親ビューから差分で伸ばす', o.expandViewAfterExport(paths, h2, h1) === 'incremental');

  const r1 = o.checkoutLayers(paths, [h1, h2], 'mb-1');
  check('whiteout で keep.txt が消える', !fs.existsSync(path.join(paths.merge, 'keep.txt')));
  check('a.txt が A2', read(path.join(paths.merge, 'src/a.txt')) === 'A2');
  const r2 = o.checkoutLayers(paths, [h1, h2], 'mb-1');
  check('2 回目はキャッシュを使う', r2.method === 'cached-view' && r2.appliedLayers === 0, JSON.stringify(r2));

  writeLayer(paths, h3, { 'src/a.txt': 'B1', 'only-b.txt': 'BONLY' });
  o.expandViewAfterExport(paths, h3, h1);
  o.checkoutLayers(paths, [h1, h3], 'mb-2');
  check('枝 B に only-b.txt がある', fs.existsSync(path.join(paths.merge, 'only-b.txt')));
  check('枝 B では keep.txt は消えていない', fs.existsSync(path.join(paths.merge, 'keep.txt')));
  o.checkoutLayers(paths, [h1, h2], 'mb-1');
  check('枝 A に戻ると only-b.txt は無い', !fs.existsSync(path.join(paths.merge, 'only-b.txt')));
  check('枝 A に戻ると a.txt は A2', read(path.join(paths.merge, 'src/a.txt')) === 'A2');
  void r1;
}

// ---------------------------------------------------------------- 4
console.log('4. `.wh.` で始まる普通のファイル（N-5）');
{
  const paths = o.ensureOverlayDirs(path.join(tmpRoot, 'wh'));
  const h1 = 'd'.repeat(40);
  writeLayer(paths, h1, { 'note.txt': 'N', '.wh.note.txt': 'not a whiteout', 'd/.wh.x': 'W' });
  o.expandViewAfterExport(paths, h1, undefined);
  const view = o.viewDir(paths, h1);
  check('.wh.note.txt が残る', fs.existsSync(path.join(view, '.wh.note.txt')));
  check('note.txt も残る', read(path.join(view, 'note.txt')) === 'N');
  check('d/.wh.x が残る', read(path.join(view, 'd', '.wh.x')) === 'W');
  check('listFilesRecursive に .wh. のファイルが出る', o.listFilesRecursive(view).includes('.wh.note.txt'));
  check('層の中に管理用のファイルが無い', !fs.readdirSync(o.layerDir(paths, h1)).some((n) => n.endsWith('.json')));
}

// ---------------------------------------------------------------- 5
console.log('5. ファイル ⇔ ディレクトリの置き換え（N-3・N-4）');
{
  const paths = o.ensureOverlayDirs(path.join(tmpRoot, 'swap'));
  const [f1, f2, g1, g2] = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  writeLayer(paths, f1, { p: 'file' });
  writeLayer(paths, f2, { p: null, 'p/q.txt': 'Q' });
  o.expandViewAfterExport(paths, f1, undefined);
  o.expandViewAfterExport(paths, f2, f1);
  const v2 = o.viewDir(paths, f2);
  check('ファイル p がディレクトリ p/ になる', fs.statSync(path.join(v2, 'p')).isDirectory() && read(path.join(v2, 'p', 'q.txt')) === 'Q');

  writeLayer(paths, g1, { 'p/q.txt': 'Q' });
  writeLayer(paths, g2, { p: 'file' }); // 子の whiteout は要らない（上の層のファイルが下のディレクトリを隠す）
  o.expandViewAfterExport(paths, g1, undefined);
  o.expandViewAfterExport(paths, g2, g1);
  const w2 = o.viewDir(paths, g2);
  check('ディレクトリ p/ がファイル p になる', fs.statSync(path.join(w2, 'p')).isFile() && read(path.join(w2, 'p')) === 'file');

  // 組み直し（views を消してレイヤだけから）でも同じになる
  fs.rmSync(paths.views, { recursive: true, force: true });
  const rebuilt = o.ensureExpandedView(paths, [f1, f2]).viewPath;
  check('組み直しでもディレクトリ p/', fs.statSync(path.join(rebuilt, 'p')).isDirectory());
  fs.rmSync(paths.views, { recursive: true, force: true });
  const rebuilt2 = o.ensureExpandedView(paths, [g1, g2]).viewPath;
  check('組み直しでもファイル p', fs.statSync(path.join(rebuilt2, 'p')).isFile());
}

// ---------------------------------------------------------------- 6
console.log('6. 実際の Git で exportCommitLayer（N-6・大きいファイル・置き換え）');
{
  const repo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  };
  // Git の既定（core.quotepath=true）を強制する。作者の PC のようにグローバル設定が false でも既定の挙動を試せる
  const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=true', ...args], { cwd: repo, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  const tryGit = (cwd, args) => {
    try { return execFileSync('git', ['-c', 'core.quotepath=true', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return undefined; }
  };
  const runGit = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=true', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');

  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD').trim(); };
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 3 MiB（v1 は 1 MiB を超えると ENOBUFS で「削除」扱い）

  fs.writeFileSync(path.join(repo, 'メモ.txt'), 'v1');
  fs.mkdirSync(path.join(repo, '資料'));
  fs.writeFileSync(path.join(repo, '資料', '議事録.md'), '# 1');
  fs.writeFileSync(path.join(repo, 'p'), 'file');
  fs.writeFileSync(path.join(repo, 'big.bin'), big);
  const c1 = commit('c1');

  fs.writeFileSync(path.join(repo, 'メモ.txt'), 'v2');
  fs.unlinkSync(path.join(repo, 'p'));
  fs.mkdirSync(path.join(repo, 'p'));
  fs.writeFileSync(path.join(repo, 'p', 'q.txt'), 'Q');
  // fs.rmSync({ recursive: true }) は Windows の Node 25.1.0 で日本語名のディレクトリに使うと落ちる（removeTree のコメント参照）
  o.removeTree(path.join(repo, '資料'));
  fs.writeFileSync(path.join(repo, '資料'), 'now a file');
  const c2 = commit('c2');

  const paths = o.ensureOverlayDirs(path.join(tmpRoot, 'gitws'));
  let threw;
  try {
    o.exportCommitLayer(repo, paths, c1, undefined, 'mb-1', runGit, tryGit);
    o.exportCommitLayer(repo, paths, c2, c1, 'mb-1', runGit, tryGit);
  } catch (e) {
    threw = e;
  }
  check('exportCommitLayer が例外を出さない', !threw, threw?.message);
  if (!threw) {
    const v1 = o.viewDir(paths, c1);
    const v2 = o.viewDir(paths, c2);
    check('日本語のファイル名がビューにある（quotepath=true）', fs.existsSync(path.join(v1, 'メモ.txt')) && read(path.join(v2, 'メモ.txt')) === 'v2');
    check('日本語のディレクトリの中身がある', read(path.join(v1, '資料', '議事録.md')) === '# 1');
    check('3 MiB のファイルが丸ごとある', fs.statSync(path.join(v2, 'big.bin')).size === big.length);
    check('ファイル p → ディレクトリ p/', fs.statSync(path.join(v2, 'p')).isDirectory() && read(path.join(v2, 'p', 'q.txt')) === 'Q');
    check('ディレクトリ 資料/ → ファイル 資料', fs.statSync(path.join(v2, '資料')).isFile() && read(path.join(v2, '資料')) === 'now a file');
    const meta = o.readLayerMeta(o.layerDir(paths, c2));
    check('ファイルに置き換わったディレクトリの子の whiteout は無い', meta && !meta.whiteouts.some((w) => w.startsWith('資料/')), JSON.stringify(meta));
    check('ファイル p の whiteout はある', meta && meta.whiteouts.includes('p'), JSON.stringify(meta));
    const tracked = o.collectShadowTrackedFiles(repo, tryGit);
    check('collectShadowTrackedFiles に日本語のパスがそのまま入る', tracked.includes('メモ.txt') && tracked.includes('資料/議事録.md'), JSON.stringify(tracked));
  }
}

// ---------------------------------------------------------------- 7
console.log('7. 形式 v1 のキャッシュを捨てる');
{
  const ws = path.join(tmpRoot, 'migrate');
  const p = o.getOverlayPaths(ws);
  // v1 のキャッシュを模す（format.json が無く、層の中に .wh. ファイル）
  fs.mkdirSync(path.join(p.layers, 'e'.repeat(40)), { recursive: true });
  fs.writeFileSync(path.join(p.layers, 'e'.repeat(40), '.wh.gone.txt'), '');
  fs.mkdirSync(path.join(p.views, 'e'.repeat(40)), { recursive: true });
  fs.mkdirSync(p.meta, { recursive: true });
  fs.writeFileSync(p.dagFile, JSON.stringify({ nodes: { ['e'.repeat(40)]: { hash: 'e'.repeat(40), parents: [], changedFiles: [] } }, managedFiles: ['keep-me.txt'] }));
  const paths = o.ensureOverlayDirs(ws);
  check('layers/ が空になる', fs.readdirSync(paths.layers).length === 0);
  check('views/ が空になる', fs.readdirSync(paths.views).length === 0);
  const dag = o.readDag(paths);
  check('dag の nodes は空、managedFiles は残る', Object.keys(dag.nodes).length === 0 && dag.managedFiles.includes('keep-me.txt'));
  check('format.json が v2', JSON.parse(read(path.join(paths.meta, 'format.json'))).layerFormat === o.LAYER_FORMAT_VERSION);
  // 2 回目は何も消さない
  writeLayer(paths, 'f'.repeat(40), { 'x.txt': 'X' });
  o.ensureOverlayDirs(ws);
  check('v2 になった後は捨てない', fs.existsSync(path.join(paths.layers, 'f'.repeat(40), 'x.txt')));
}

// ---------------------------------------------------------------- 8
console.log('8. ワークスペースへの同期でファイル ⇔ ディレクトリを置き換える（N-7、#14 の差分テストで発見）');
{
  const ws = path.join(tmpRoot, 'sync');
  const paths = o.ensureOverlayDirs(ws);
  const safe = (rel) => !!rel && !path.isAbsolute(rel) && !rel.split('/').includes('..');
  const artifact = (abs, root) => abs.startsWith(path.join(root, '.microgit_'));
  const managed = ['p', 'p/q.txt', 'dir', 'dir/x.txt'];
  const [a1, a2, a3] = ['5', '6', '7'].map((c) => c.repeat(40));
  writeLayer(paths, a1, { p: 'file', 'dir/x.txt': 'X' });
  writeLayer(paths, a2, { p: null, 'p/q.txt': 'Q', 'dir/x.txt': null, dir: 'now a file' });
  o.expandViewAfterExport(paths, a1, undefined);
  o.expandViewAfterExport(paths, a2, a1);
  o.checkoutLayers(paths, [a1], 'mb-1');
  o.syncMergeToWorkspace(ws, paths, safe, artifact, managed);
  check('a1: p はファイル、dir/x.txt がある', fs.statSync(path.join(ws, 'p')).isFile() && fs.existsSync(path.join(ws, 'dir', 'x.txt')));
  let threw;
  let r2;
  try {
    o.checkoutLayers(paths, [a1, a2], 'mb-1');
    r2 = o.syncMergeToWorkspace(ws, paths, safe, artifact, managed);
  } catch (e) {
    threw = e;
  }
  check('a2 へ: 例外にならない（以前は mkdir が EEXIST）', !threw, threw?.message);
  check('a2 へ: 置けないものは無い', r2 && r2.conflicts.length === 0, JSON.stringify(r2?.conflicts));
  check('a2: p はディレクトリ、dir はファイル', !threw && fs.statSync(path.join(ws, 'p')).isDirectory() && fs.statSync(path.join(ws, 'dir')).isFile());
  o.checkoutLayers(paths, [a1], 'mb-1');
  o.syncMergeToWorkspace(ws, paths, safe, artifact, managed);
  check('a1 へ戻る: p はファイル、dir はディレクトリ', fs.statSync(path.join(ws, 'p')).isFile() && fs.statSync(path.join(ws, 'dir')).isDirectory());
  fs.mkdirSync(path.join(ws, 'userdir'));
  fs.writeFileSync(path.join(ws, 'userdir', 'mine.txt'), 'keep');
  writeLayer(paths, a3, { userdir: 'file from history' });
  o.expandViewAfterExport(paths, a3, a1);
  o.checkoutLayers(paths, [a1, a3], 'mb-1');
  const r3 = o.syncMergeToWorkspace(ws, paths, safe, artifact, managed);
  check('利用者のファイルがあるディレクトリは置き換えずに conflicts で知らせる', r3.conflicts.includes('userdir') && fs.existsSync(path.join(ws, 'userdir', 'mine.txt')), JSON.stringify(r3.conflicts));
}

o.removeTree(tmpRoot);
if (failures) {
  console.error(`\n${failures} 件失敗`);
  process.exit(1);
}
console.log(`\nOK (${process.platform})`);
