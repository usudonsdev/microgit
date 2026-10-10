#!/usr/bin/env node
/**
 * ジャーナルへの追記の「確定のやり方」ごとの費用を比べる小さなベンチ（docs/save-bottleneck-investigation.md §9.3）。
 *
 * 目的：保存 1 回の記録は Journal.append（src/fastGit/journal.ts）が、開きっぱなしのファイルに 1 件を追記し、
 *   fdatasyncSync で同期に確定させている。CI の Windows ではこの fsync が重い（中央値 5.29 ms、p95 17.32 ms）うえ、
 *   同期なので拡張機能のプロセス（イベントループ）が止まる。確定のやり方を変えると安くなるかを見る。
 *
 * 使い方（依存なし。Node 20 の標準だけ）:
 *   node scripts/bench-journal-fsync.mjs [--json <結果を書く JSON のパス>] [--n 300] [--warmup 20]
 *   標準出力に「方法 × 1 件の大きさ」の表（ms）を出す。ファイルは os.tmpdir() の下に作り、終わったら消す。
 *   （拡張機能テストのワークスペースも os.tmpdir() の下なので、同じディスクで測るため）
 *
 * 方法（1 件の大きさは 2 KiB と 16 KiB。中身は乱数。各方法・各大きさで ウォームアップ 20 回 → 測定 300 回）:
 *   current        今と同じ。openSync(file,'a') で開きっぱなし → 1 件ごとに writeSync → fdatasyncSync。
 *   prealloc-trunc 先に 8 MiB を ftruncate で確保（穴あきファイル）。'r+' で開き、位置を指定して writeSync → fdatasyncSync。
 *                  （ウォームアップ込み 320 回 × 16 KiB = 約 5 MiB が入るよう 8 MiB。4 MiB では足りない）
 *   prealloc-zero  同じ 8 MiB を 0 で埋めて fsync してから測る。穴あきでないので、ブロックの割り当て自体が測定に入らない。
 *   wt-dsync       O_DSYNC を付けて開く（追記）。writeSync だけで、あとから fsync を呼ばない。
 *   wt-sync        O_SYNC を付けて開く（追記）。同上。fs.constants に無い環境では「使えない」と表に出して続ける。
 *   wt-*-raw       （Windows のみ）fs.constants に O_DSYNC / O_SYNC が無いので、libuv の内部の値を生で渡して試す（下の注を参照）。
 *   async          current と同じ開き方で、fs.fdatasync（コールバック。libuv のスレッドプール）で確定させ、待つ。
 *   loop-baseline  （参考）ファイル操作なしで setImmediate を回しただけの、イベントループの 1 周のすき間。
 *
 * loop最長：current と async では、測定中ずっと setImmediate を連鎖させ、1 周のすき間（ms）の最長を測る。
 *   同期版はその間ループが止まるので、すき間が fsync の時間まで伸びる。async で伸びなければ、ループは止まっていない。
 *   （どちらも 1 件ごとに setImmediate を 1 度待ってから次に進み、ループに順番を渡す。）
 *
 * 注意：時間は writeSync と確定の合計。ディスクキャッシュや仮想マシンの揺れがあるので、
 *   別の環境や別の時間帯の値との比較は目安にとどめる。
 */
import fs from 'fs'; import os from 'os'; import path from 'path';
import { performance } from 'perf_hooks';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const JSON_OUT = opt('--json', null);
const N = Number(opt('--n', 300));
const WARMUP = Number(opt('--warmup', 20));
const SIZES = [2 * 1024, 16 * 1024];
const PREALLOC = 8 * 1024 * 1024;
const C = fs.constants;

const immediate = () => new Promise((r) => setImmediate(r));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] }; };

function writeAll(fd, buf, pos) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, pos === undefined ? null : pos + off);
}

/** イベントループの 1 周のすき間を測る。stop() で止めて最長（ms）を返す */
function startLoopMeter() {
  let last = performance.now(), max = 0, run = true;
  const tick = () => { const t = performance.now(); max = Math.max(max, t - last); last = t; if (run) setImmediate(tick); };
  setImmediate(tick);
  return { reset() { max = 0; last = performance.now(); }, stop() { run = false; return max; } };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfsync-'));
let fileNo = 0;
const newFile = () => path.join(dir, `j${fileNo++}.log`);

/** 方法の定義。setup は {write(buf), close()} を返す。使えないときは {unavailable: 理由} を返すか throw する */
const methods = [
  { name: 'current', loop: true, setup() {
    const fd = fs.openSync(newFile(), 'a', 0o644);
    return { write(buf) { writeAll(fd, buf); fs.fdatasyncSync(fd); }, close() { fs.closeSync(fd); } };
  } },
  { name: 'prealloc-trunc', setup() {
    const f = newFile(); fs.writeFileSync(f, ''); fs.truncateSync(f, PREALLOC);
    const fd = fs.openSync(f, 'r+'); fs.fsyncSync(fd); let pos = 0;
    return { write(buf) { writeAll(fd, buf, pos); pos += buf.length; fs.fdatasyncSync(fd); }, close() { fs.closeSync(fd); } };
  } },
  { name: 'prealloc-zero', setup() {
    const f = newFile(); const fd = fs.openSync(f, 'w+'); const z = Buffer.alloc(1024 * 1024);
    for (let o = 0; o < PREALLOC; o += z.length) writeAll(fd, z, o);
    fs.fsyncSync(fd); let pos = 0;
    return { write(buf) { writeAll(fd, buf, pos); pos += buf.length; fs.fdatasyncSync(fd); }, close() { fs.closeSync(fd); } };
  } },
  ...[['wt-dsync', 'O_DSYNC'], ['wt-sync', 'O_SYNC']].map(([name, flag]) => ({ name, setup() {
    if (typeof C[flag] !== 'number') return { unavailable: `fs.constants.${flag} が無い` };
    const fd = fs.openSync(newFile(), C.O_WRONLY | C.O_CREAT | C.O_APPEND | C[flag], 0o644);
    return { write(buf) { writeAll(fd, buf); }, close() { fs.closeSync(fd); } };
  } })),
  // Windows の Node は fs.constants に O_DSYNC / O_SYNC を出さない。libuv の内部の値（UV_FS_O_DSYNC=0x04000000、UV_FS_O_SYNC=0x08000000。
  // どちらも FILE_FLAG_WRITE_THROUGH になるはず。公開された値ではなく、筆者の記憶による。別の値なら開けない・効かないので、結果は参考）を生で渡して試す。
  ...(process.platform === 'win32' ? [['wt-dsync-raw', 0x04000000], ['wt-sync-raw', 0x08000000]].map(([name, raw]) => ({ name, setup() {
    const fd = fs.openSync(newFile(), C.O_WRONLY | C.O_CREAT | C.O_APPEND | raw);
    return { write(buf) { writeAll(fd, buf); }, close() { fs.closeSync(fd); } };
  } })) : []),
  { name: 'async', loop: true, setup() {
    const fd = fs.openSync(newFile(), 'a', 0o644);
    return { write(buf) { writeAll(fd, buf); return new Promise((res, rej) => fs.fdatasync(fd, (e) => (e ? rej(e) : res()))); }, close() { fs.closeSync(fd); } };
  } },
];

const results = [];
try {
  // 参考：ファイル操作なしのループのすき間
  { const m = startLoopMeter(); for (let i = 0; i < N; i++) await immediate(); results.push({ method: 'loop-baseline', size: 0, loopMaxMs: m.stop() }); }

  for (const m of methods) {
    for (const size of SIZES) {
      const rec = { method: m.name, size };
      let h;
      try { h = m.setup(); } catch (e) { h = { unavailable: `開けない: ${e.code ?? ''} ${e.message}` }; }
      if (h.unavailable) { rec.unavailable = h.unavailable; results.push(rec); continue; }
      try {
        const buf = Buffer.alloc(size);
        const times = [];
        const meter = m.loop ? startLoopMeter() : null;
        for (let i = 0; i < WARMUP + N; i++) {
          globalThis.crypto.getRandomValues(buf.subarray(0, Math.min(size, 65536))); // 中身は乱数
          if (i === WARMUP) meter?.reset();
          const t = performance.now();
          await h.write(buf);
          const dt = performance.now() - t;
          if (i >= WARMUP) times.push(dt);
          if (meter) await immediate(); // ループに順番を渡す（同期版は止まっていた分がここですき間に出る）
        }
        if (meter) rec.loopMaxMs = meter.stop();
        Object.assign(rec, stats(times), { n: times.length });
      } catch (e) { rec.unavailable = `実行できない: ${e.code ?? ''} ${e.message}`; }
      finally { try { h.close(); } catch { /* 閉じられなくても続ける */ } }
      results.push(rec);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const env = { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, tmpdir: os.tmpdir(), n: N, warmup: WARMUP, prealloc: PREALLOC,
  constants: { O_DSYNC: C.O_DSYNC ?? null, O_SYNC: C.O_SYNC ?? null } };
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ env, results }, null, 2));

const f = (x) => (x === undefined ? '-' : x.toFixed(2));
const kib = (b) => (b ? `${b / 1024}KiB` : '-');
const width = (s) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
console.log(`# ${env.platform} ${env.release} ${env.arch} node ${env.node} / ${env.cpu} / tmp=${env.tmpdir}`);
console.log(`# 各 ${N} 回（ウォームアップ ${WARMUP} 回を除く）。単位 ms。O_DSYNC=${env.constants.O_DSYNC} O_SYNC=${env.constants.O_SYNC}`);
const rows = [['方法', '大きさ', '中央値', 'p95', '最大', 'loop最長']];
for (const r of results) rows.push(r.unavailable ? [r.method, kib(r.size), '使えない', '-', '-', '-'] : [r.method, kib(r.size), f(r.median), f(r.p95), f(r.max), f(r.loopMaxMs)]);
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))));
for (const r of rows) console.log(r.map((c, i) => String(c) + ' '.repeat(Math.max(0, w[i] - width(c)))).join('  ').trimEnd());
for (const r of results) if (r.unavailable) console.log(`# ${r.method} ${kib(r.size)}: ${r.unavailable}`);
