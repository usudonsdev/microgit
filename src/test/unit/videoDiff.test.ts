/**
 * 動画の差分（video.ts）の単体テスト（docs/structured-diff.md §3.2）。見本の動画はテストの中で ffmpeg で作る。
 * ffmpeg・ffprobe が PATH に無ければ飛ばす。観点：書き出し直しただけ（画質の設定が違う）なら unchanged。
 * 途中を 1 秒切り取ると、その時刻の deleted。途中の 1 秒に図形を重ねると、その時刻の modified。ffmpeg が無ければ error（tool）。
 */
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, before, after } from 'node:test';
import { videoDriver, alignSequences } from '../../diff/video';
import { DEFAULT_LIMITS, DiffContext, VideoDiff } from '../../diff/types';
import { resolveToolsForTest } from './helpers/tools';

const tools = resolveToolsForTest();
const has = !!tools.ffmpegPath && !!tools.ffprobePath;

describe('動画の差分', { skip: has ? false : 'ffmpeg が無い' }, () => {
    let dir = '';
    const ctx = (): DiffContext => ({ limits: { ...DEFAULT_LIMITS }, tools, tmpDir: dir });
    const ff = (...args: string[]) => execFileSync(tools.ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    const file = (n: string) => path.join(dir, n);
    const run = async (a: string, b: string) => (await videoDriver.diff({
        path: 'clip.mp4', oldBytes: fs.readFileSync(file(a)), newBytes: fs.readFileSync(file(b)), oldFile: file(a), newFile: file(b),
    }, ctx())) as VideoDiff;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vereve-video-test-'));
        const src = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'];
        ff(...src, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('base.mp4'));
        ff(...src, '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('reenc.mp4'));
        // 2〜3 秒を切り取る
        ff('-i', file('base.mp4'), '-filter_complex', '[0:v]select=\'not(between(t,2,3-0.001))\',setpts=N/10/TB[v];[0:a]aselect=\'not(between(t,2,3-0.001))\',asetpts=N/SR/TB[a]',
            '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('cut.mp4'));
        // 3〜4 秒に赤い四角を重ねる
        ff('-i', file('base.mp4'), '-vf', 'drawbox=x=20:y=20:w=60:h=40:color=red:t=fill:enable=\'between(t,3,4)\'', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', file('box.mp4'));
    });
    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    it('書き出し直しただけなら unchanged', async () => {
        const d = await run('base.mp4', 'reenc.mp4');
        assert.equal(d.status, 'unchanged', d.summary);
    });
    it('途中を 1 秒切り取ると、その時刻の deleted', async () => {
        const d = await run('base.mp4', 'cut.mp4');
        const del = d.segments.filter((s) => s.type === 'deleted');
        assert.equal(del.length, 1, JSON.stringify(d.segments.map((s) => s.type)));
        assert.ok(Math.abs(del[0].oldStart! - 2) <= 0.2 && Math.abs(del[0].oldEnd! - 3) <= 0.2, JSON.stringify(del[0]));
        assert.ok(d.segments.every((s) => s.type === 'equal' || s.type === 'deleted'), d.summary);
        assert.ok(del[0].thumbOld?.startsWith('data:image/png;base64,'));
    });
    it('途中の 1 秒に図形を重ねると、その時刻の modified', async () => {
        const d = await run('base.mp4', 'box.mp4');
        const mod = d.segments.filter((s) => s.type === 'modified');
        assert.equal(mod.length, 1, JSON.stringify(d.segments.map((s) => s.type)));
        assert.ok(Math.abs(mod[0].newStart! - 3) <= 0.2 && Math.abs(mod[0].newEnd! - 4) <= 0.2, JSON.stringify(mod[0]));
        assert.ok(mod[0].heat?.startsWith('data:image/png;base64,'));
        assert.ok((d.audio?.segments ?? []).every((s) => s.type === 'equal'), '音声は変えていない');
    });
    it('ffmpeg が無ければ error（tool）', async () => {
        const d = await videoDriver.diff({ path: 'a.mp4', oldBytes: Buffer.alloc(10), newBytes: Buffer.alloc(10) }, { ...ctx(), tools: {} });
        assert.equal(d.kind, 'error');
    });
});

describe('列の対応づけ（alignSequences）', () => {
    it('途中の削除と挿入を見つける', () => {
        const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const b = [1, 2, 3, 6, 7, 8, 99, 98, 9, 10];
        const segs = alignSequences(a.length, b.length, (i, j) => a[i] === b[j], 20, 2).map((s) => s.type);
        assert.deepEqual(segs.filter((t) => t !== 'equal').sort(), ['deleted', 'inserted']);
    });
});
