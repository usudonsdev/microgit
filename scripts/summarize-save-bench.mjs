#!/usr/bin/env node
/**
 * CI の保存の計測（package.yml が残す save-bench-*.json）を、環境ごとにまとめて比べる。
 * 新しいコミットを作った保存の、最後の N 回（既定 50）の中央値を出す。
 *
 * 使い方: node scripts/summarize-save-bench.mjs <前のディレクトリ> [<後のディレクトリ>] [--last 50]
 * 例:     node scripts/summarize-save-bench.mjs docs/paper/data/ci-36882411545 docs/paper/data/ci-<run>
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const lastIdx = args.indexOf('--last');
const LAST = lastIdx >= 0 ? Number(args.splice(lastIdx, 2)[1]) : 50;
const dirs = args;
if (dirs.length === 0) {
    console.error('使い方: node scripts/summarize-save-bench.mjs <前のディレクトリ> [<後のディレクトリ>] [--last 50]');
    process.exit(2);
}

const median = (xs) => {
    if (xs.length === 0) { return NaN; }
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 1 つのディレクトリの、環境ごとのまとめ */
function summarize(dir) {
    const out = new Map();
    for (const name of fs.readdirSync(dir).filter((n) => /^save-bench-.*\.json$/.test(n)).sort()) {
        const env = name.replace(/^save-bench-/, '').replace(/\.json$/, '');
        const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const saves = j.saves.filter((s) => s.result === 'created').slice(-LAST);
        const phase = (k) => median(saves.map((s) => s.commitPhases?.[k] ?? 0));
        out.set(env, {
            n: saves.length,
            total: median(saves.map((s) => s.totalMs)),
            commit: median(saves.map((s) => s.stages.commit ?? 0)),
            recorded: median(saves.map((s) => s.recordedMs ?? NaN)),
            fsyncCount: phase('fsyncCount'),
            fsyncMs: phase('fsyncMs'),
            journal: phase('journal'),
        });
    }
    return out;
}

const runs = dirs.map((d) => ({ dir: d, envs: summarize(d) }));
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const envs = [...new Set(runs.flatMap((r) => [...r.envs.keys()]))];
const cols = ['total', 'commit', 'recorded', 'fsyncCount', 'fsyncMs', 'journal'];
console.log(`最後の ${LAST} 回（新しいコミットを作った保存）の中央値、ms`);
console.log(['環境', ...runs.flatMap((r, i) => cols.map((c) => `${c}#${i + 1}`))].join('\t'));
for (const env of envs) {
    console.log([env, ...runs.flatMap((r) => {
        const v = r.envs.get(env);
        return cols.map((c) => (v ? fmt(v[c]) : '-'));
    })].join('\t'));
}
runs.forEach((r, i) => console.log(`#${i + 1}: ${r.dir}`));
