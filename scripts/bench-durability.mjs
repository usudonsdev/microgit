#!/usr/bin/env node
/**
 * マイクロ履歴の永続性の水準ごとに、保存 1 回ぶんの Git の手順の時間を測る（#11 の O-11、docs/adr/0002-durability.md）。
 * 使い方: node scripts/bench-durability.mjs   （N=40 回。環境変数 N で変えられる）
 *
 * MicroGit の保存（runShadowCommit）と同じ 4 手順（add → write-tree → commit-tree → update-ref）を、
 * Git のプロセスとして 1 つずつ起動して測る。
 * 2026-09-26、Windows 11・Git 2.50.1 での結果: 既定 p50 99.9 ms、power（loose-object,reference を batch で fsync）p50 106.9 ms。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const N = Number(process.env.N || 40);
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid',
};

function bench(label, extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-durability-bench-'));
    const git = (...a) => execFileSync('git', [...extra, ...a], { cwd: dir, encoding: 'utf8', env });
    git('init', '-q');
    let parent = '';
    const times = [];
    for (let i = 0; i < N; i++) {
        fs.writeFileSync(path.join(dir, 'f.txt'), `content ${i} ${'x'.repeat(2000)}`);
        const t = process.hrtime.bigint();
        git('add', '--', 'f.txt');
        const tree = git('write-tree').trim();
        const args = ['commit-tree', tree, '-m', `m${i}`];
        if (parent) { args.push('-p', parent); }
        const c = git(...args).trim();
        git('update-ref', 'refs/heads/micro-history', c);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
        parent = c;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    times.sort((a, b) => a - b);
    const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
    console.log(`${label.padEnd(44)} p50 ${p(0.5)} ms  p90 ${p(0.9)} ms`);
}

console.log(`git ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim().replace(/^git version /, '')}, ${process.platform}, N=${N}`);
bench('process（Git の既定）', []);
bench('power（loose-object,reference / batch）', ['-c', 'core.fsync=loose-object,reference', '-c', 'core.fsyncMethod=batch']);
bench('参考: loose-object,reference / fsync', ['-c', 'core.fsync=loose-object,reference', '-c', 'core.fsyncMethod=fsync']);
