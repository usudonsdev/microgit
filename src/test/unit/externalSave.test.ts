/**
 * VS Code の外で保存されたファイルの記録の部品（externalSave.ts）を確かめる単体テスト（docs/external-saves.md）。
 * 観点：一時ファイル・ロックファイル・.git の中・大きすぎるファイルを記録しない。書き終わる（大きさと更新時刻が settleMs 変わらない）まで待つ。
 * 連続の通知は 1 回にまとめる。消えたファイルは知らせない。最後に記録した中身と同じなら記録しない。VS Code は使わない。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { FileSignature, RecordedContents, SettleWatcher, decideExternalSave, isInsideGitDir, isTransientFileName } from '../../externalSave';

/** 手で進める偽のタイマーと、書き換えられる偽のファイル */
function harness(settleMs = 1000) {
    let now = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const files = new Map<string, FileSignature>();
    const settled: string[] = [];
    const w = new SettleWatcher(settleMs, (p) => settled.push(p), {
        stat: (p) => files.get(p),
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: (h) => { timers.delete(h as number); },
    });
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) { break; }
            timers.delete(due[0]);
            now = due[1].at;
            due[1].fn();
        }
        now = end;
    };
    return { w, files, settled, advance, timers };
}

describe('記録しないファイル名', () => {
    it('Office・LibreOffice のロックファイル、一時ファイル、エディタのスワップ、OS のファイル', () => {
        for (const n of ['~$book.xlsx', '.~lock.book.xlsx#', '~WRL0001.tmp', 'ABCD1234.TMP', 'a.txt.swp', 'notes.md~', '#notes.md#',
            'movie.mp4.part', 'x.crdownload', '.DS_Store', 'Thumbs.db', 'desktop.ini', '._book.xlsx', 'dir/sub/~$report.docx']) {
            assert.ok(isTransientFileName(n), n);
        }
    });
    it('普通の文書・動画・ソースは記録する', () => {
        for (const n of ['book.xlsx', 'report.docx', 'movie.mp4', 'src/a.ts', 'temp.xlsx', 'a~b.txt', 'my#file.txt']) {
            assert.ok(!isTransientFileName(n), n);
        }
    });
    it('.git の中は記録しない（.gitignore などの名前は対象）', () => {
        assert.ok(isInsideGitDir('.git/index'));
        assert.ok(isInsideGitDir('sub/.git/HEAD'));
        assert.ok(!isInsideGitDir('.gitignore'));
        assert.ok(!isInsideGitDir('a/.github/workflows/ci.yml'));
    });
    it('大きさの上限を超えると記録しない。0 は上限なし', () => {
        assert.deepEqual(decideExternalSave('book.xlsx', 10, 100), { record: true });
        assert.equal(decideExternalSave('movie.mp4', 101, 100).record, false);
        assert.deepEqual(decideExternalSave('movie.mp4', 10 ** 10, 0), { record: true });
        assert.equal(decideExternalSave('~$book.xlsx', 1, 100).record, false);
    });
});

describe('書き終わるまで待つ（SettleWatcher）', () => {
    it('大きさと更新時刻が settleMs 変わらなければ 1 回知らせる', () => {
        const h = harness();
        h.files.set('/w/a.xlsx', { size: 10, mtimeMs: 1 });
        h.w.notify('/w/a.xlsx');
        h.advance(999);
        assert.deepEqual(h.settled, []);
        h.advance(1);
        assert.deepEqual(h.settled, ['/w/a.xlsx']);
        assert.equal(h.w.pendingCount, 0);
    });
    it('待っている間の通知は 1 回にまとめ、最後の通知から数え直す', () => {
        const h = harness();
        h.files.set('/w/a.xlsx', { size: 10, mtimeMs: 1 });
        h.w.notify('/w/a.xlsx');
        h.advance(500);
        h.w.notify('/w/a.xlsx');
        h.advance(500);
        h.w.notify('/w/a.xlsx');
        h.advance(999);
        assert.deepEqual(h.settled, []);
        h.advance(1);
        assert.deepEqual(h.settled, ['/w/a.xlsx']);
    });
    it('通知が来なくても、書き続けている（大きさが増える）あいだは待ち続ける', () => {
        const h = harness();
        h.files.set('/w/movie.mp4', { size: 100, mtimeMs: 1 });
        h.w.notify('/w/movie.mp4');
        for (let i = 2; i <= 10; i++) {
            h.files.set('/w/movie.mp4', { size: 100 * i, mtimeMs: i });
            h.advance(1000);
            assert.deepEqual(h.settled, [], `書き出し中 ${i}`);
        }
        h.advance(1000); // 書き終わってから 1 回目の確認で同じ → 知らせる
        assert.deepEqual(h.settled, ['/w/movie.mp4']);
    });
    it('大きさが同じでも更新時刻が変われば待つ', () => {
        const h = harness();
        h.files.set('/w/a.bin', { size: 10, mtimeMs: 1 });
        h.w.notify('/w/a.bin');
        h.files.set('/w/a.bin', { size: 10, mtimeMs: 2 });
        h.advance(1000);
        assert.deepEqual(h.settled, []);
        h.advance(1000);
        assert.deepEqual(h.settled, ['/w/a.bin']);
    });
    it('消えたファイル（一時ファイルの改名など）は知らせずに忘れる', () => {
        const h = harness();
        h.files.set('/w/tmp.bin', { size: 1, mtimeMs: 1 });
        h.w.notify('/w/tmp.bin');
        h.files.delete('/w/tmp.bin');
        h.advance(5000);
        assert.deepEqual(h.settled, []);
        assert.equal(h.w.pendingCount, 0);
    });
    it('通知の時点で stat が取れなくても、あとで現れて落ち着けば知らせる', () => {
        const h = harness();
        h.w.notify('/w/late.xlsx');
        h.files.set('/w/late.xlsx', { size: 5, mtimeMs: 1 });
        h.advance(1000);
        assert.deepEqual(h.settled, []);
        h.advance(1000);
        assert.deepEqual(h.settled, ['/w/late.xlsx']);
    });
    it('forget と dispose で待ちを取り消す', () => {
        const h = harness();
        h.files.set('/w/a', { size: 1, mtimeMs: 1 });
        h.files.set('/w/b', { size: 1, mtimeMs: 1 });
        h.w.notify('/w/a');
        h.w.notify('/w/b');
        h.w.forget('/w/a');
        assert.equal(h.w.pendingCount, 1);
        h.w.dispose();
        h.advance(5000);
        assert.deepEqual(h.settled, []);
        assert.equal(h.timers.size, 0);
        h.w.notify('/w/a'); // dispose のあとは受け付けない
        assert.equal(h.w.pendingCount, 0);
    });
});

describe('最後に記録した中身（RecordedContents）', () => {
    it('同じパス・同じハッシュなら既知、違えば未知', () => {
        const r = new RecordedContents();
        r.remember('/w/a', 'h1');
        assert.ok(r.isKnown('/w/a', 'h1'));
        assert.ok(!r.isKnown('/w/a', 'h2'));
        assert.ok(!r.isKnown('/w/b', 'h1'));
        r.remember('/w/a', 'h2');
        assert.ok(!r.isKnown('/w/a', 'h1'));
        r.forget('/w/a');
        assert.ok(!r.isKnown('/w/a', 'h2'));
    });
    it('上限を超えたら古いものから忘れる（最近覚え直したものは残る）', () => {
        const r = new RecordedContents(2);
        r.remember('/a', '1');
        r.remember('/b', '2');
        r.remember('/a', '1'); // 覚え直し → /b がいちばん古い
        r.remember('/c', '3');
        assert.ok(r.isKnown('/a', '1'));
        assert.ok(!r.isKnown('/b', '2'));
        assert.ok(r.isKnown('/c', '3'));
    });
});
