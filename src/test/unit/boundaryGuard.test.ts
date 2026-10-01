import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import {
    checkPathPolicy,
    checkPathShape,
    collisionKey,
    hostTraitsFor,
    isGitDirSegment,
    isInsideWorkspace,
    syncWorkspaceFromGuest,
    validateViewEntries,
    verifyContent,
} from '../../boundaryGuard';

const linux = hostTraitsFor('linux');
const windows = hostTraitsFor('win32');
const mac = hostTraitsFor('darwin');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const f = (p: string, content = 'x') => `f\t${p}\t${sha(content)}`;

describe('パスの形（SR-2）', () => {
    test('相対パスで、空・.・.. の段が無いものだけ通す', () => {
        for (const ok of ['a.txt', 'dir/b.txt', '日本語/メモ.txt', '.wh.note', 'a..b', '...']) {
            assert.strictEqual(checkPathShape(ok), undefined, ok);
        }
        for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'C:/x', 'c:x', 'a\\b', 'a\0b', 'a/']) {
            assert.strictEqual(checkPathShape(bad), 'bad-path', JSON.stringify(bad));
        }
    });

    test('長さの上限（段 255 バイト、全体 4096 バイト）', () => {
        assert.strictEqual(checkPathShape('a'.repeat(255)), undefined);
        assert.strictEqual(checkPathShape('a'.repeat(256)), 'too-long');
        assert.strictEqual(checkPathShape('あ'.repeat(86)), 'too-long'); // 3 バイト × 86 = 258
        assert.strictEqual(checkPathShape(Array(1000).fill('abcd').join('/')), 'too-long');
    });
});

describe('.git への書き込みを弾く（CVE-2014-9390 と同じ種類の攻撃）', () => {
    test('大文字小文字・末尾のドットや空白・8.3 の短い名前・macOS が無視する文字', () => {
        for (const seg of ['.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', 'git~1', 'GIT~1', 'git~12', '.g\u200cit', '\ufeff.git']) {
            assert.ok(isGitDirSegment(seg), JSON.stringify(seg));
        }
        for (const seg of ['.gitignore', '.github', 'git', '.gitx', 'git~', 'x.git']) {
            assert.ok(!isGitDirSegment(seg), JSON.stringify(seg));
        }
    });

    test('パスのどの段にあっても弾く', () => {
        for (const p of ['.git/hooks/post-checkout', 'sub/.GIT/config', 'a/git~1/HEAD']) {
            assert.deepStrictEqual(checkPathPolicy(p, linux), { reason: 'git-dir' }, p);
        }
        assert.strictEqual(checkPathPolicy('.github/workflows/ci.yml', linux), undefined);
    });

    test('MicroGit の作業フォルダは弾く（大文字小文字を区別しない FS では大文字でも）', () => {
        assert.strictEqual(checkPathPolicy('.microgit_shadow/x', linux)?.reason, 'microgit-artifact');
        assert.strictEqual(checkPathPolicy('.MICROGIT_OVERLAY/x', windows)?.reason, 'microgit-artifact');
        assert.strictEqual(checkPathPolicy('.MICROGIT_OVERLAY/x', linux), undefined);
        assert.strictEqual(checkPathPolicy('sub/.microgit_logs/x', linux), undefined); // ワークスペース直下だけ
    });
});

describe('Windows で表せない名前（O-14）', () => {
    test('予約名（拡張子付きも）、使えない文字、末尾のドットや空白', () => {
        for (const [p, reason] of [
            ['CON', 'windows-reserved-name'], ['con.txt', 'windows-reserved-name'], ['dir/NUL', 'windows-reserved-name'],
            ['COM1.log', 'windows-reserved-name'], ['lpt9', 'windows-reserved-name'], ['COM¹', 'windows-reserved-name'],
            ['a:b', 'windows-invalid-char'], ['what?.txt', 'windows-invalid-char'], ['x|y', 'windows-invalid-char'], ['tab\there', 'windows-invalid-char'],
            ['name.', 'windows-trailing-dot-or-space'], ['dir /x', 'windows-trailing-dot-or-space'],
        ] as const) {
            assert.strictEqual(checkPathPolicy(p, windows)?.reason, reason, p);
            assert.strictEqual(checkPathPolicy(p, linux), undefined, `linux: ${p}`);
        }
        for (const ok of ['CONFIG', 'console.log', 'com10', 'nul-safe.txt']) {
            assert.strictEqual(checkPathPolicy(ok, windows), undefined, ok);
        }
    });
});

describe('view の一覧の検証', () => {
    test('ファイルとディレクトリを受け付け、リンクやその他は弾く', () => {
        const v = validateViewEntries(['d\tsrc', f('src/a.ts'), 'l\tlink\tsrc', 'o\tdev', f('README.md')], linux);
        assert.deepStrictEqual(v.directories, ['src']);
        assert.deepStrictEqual(v.files.map((x) => x.path), ['README.md', 'src/a.ts']);
        assert.deepStrictEqual(v.rejected.map((r) => [r.path, r.reason]), [['dev', 'unsupported-type'], ['link', 'unsupported-type']]);
    });

    test('壊れた行、sha256 の無いファイル、知らない種類', () => {
        const v = validateViewEntries(['f\ta.txt', 'f\tb.txt\tnothex', 'x\tc', 'garbage'], linux);
        assert.deepStrictEqual(v.files, []);
        assert.ok(v.rejected.every((r) => r.reason === 'malformed'), JSON.stringify(v.rejected));
        assert.strictEqual(v.rejected.length, 4);
    });

    test('弾いたディレクトリの下は全部弾く', () => {
        const v = validateViewEntries(['d\t.git', 'd\t.git/hooks', f('.git/hooks/pre-commit'), f('ok.txt')], linux);
        assert.deepStrictEqual(v.files.map((x) => x.path), ['ok.txt']);
        assert.strictEqual(v.rejected.length, 3);
    });

    test('大文字小文字だけ違う名前は、区別しない FS では後のほうを弾く', () => {
        const lines = [f('A.ts'), f('a.ts')];
        assert.strictEqual(validateViewEntries(lines, linux).files.length, 2);
        const w = validateViewEntries(lines, windows);
        assert.deepStrictEqual(w.files.map((x) => x.path), ['A.ts']);
        assert.deepStrictEqual(w.rejected.map((r) => [r.path, r.reason, r.detail]), [['a.ts', 'case-conflict', 'A.ts']]);
    });

    test('Unicode の正規化だけ違う名前は、macOS では同じものとして弾く', () => {
        const nfc = 'が.txt'.normalize('NFC');
        const nfd = 'が.txt'.normalize('NFD');
        assert.notStrictEqual(nfc, nfd);
        assert.strictEqual(validateViewEntries([f(nfc), f(nfd)], linux).files.length, 2);
        assert.strictEqual(validateViewEntries([f(nfc), f(nfd)], windows).files.length, 2);
        assert.strictEqual(validateViewEntries([f(nfc), f(nfd)], mac).files.length, 1);
        assert.strictEqual(collisionKey(nfd, mac), collisionKey(nfc, mac));
    });

    test('一覧が多すぎるときは全体を弾く', () => {
        const v = validateViewEntries([f('a'), f('b'), f('c')], linux, { maxPathBytes: 4096, maxSegmentBytes: 255, maxEntries: 2, maxFileBytes: 10 });
        assert.deepStrictEqual(v.rejected.map((r) => r.reason), ['too-many-entries']);
    });
});

describe('中身の照合', () => {
    test('sha256 が一致しなければ弾く、大きすぎても弾く', () => {
        const file = { path: 'a.txt', sha256: sha('hello') };
        assert.strictEqual(verifyContent(file, Buffer.from('hello')), undefined);
        assert.strictEqual(verifyContent(file, Buffer.from('hellO'))?.reason, 'hash-mismatch');
        assert.strictEqual(verifyContent(file, Buffer.from('hello'), { maxPathBytes: 4096, maxSegmentBytes: 255, maxEntries: 10, maxFileBytes: 3 })?.reason, 'too-large');
    });
});

function tempWorkspace(): { root: string; outside: string; done: () => void } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-guard-'));
    const root = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    return { root, outside, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** ディレクトリへのリンクを作る（Windows は管理者権限の要らないジャンクション） */
function linkDir(target: string, at: string): void {
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('書き込み先がワークスペースの外に出ないか', () => {
    test('途中のディレクトリがワークスペースの外を指すリンクなら false', () => {
        const ws = tempWorkspace();
        try {
            linkDir(ws.outside, path.join(ws.root, 'escape'));
            fs.mkdirSync(path.join(ws.root, 'real'));
            assert.strictEqual(isInsideWorkspace(ws.root, 'escape/pwned.txt'), false);
            assert.strictEqual(isInsideWorkspace(ws.root, 'real/ok.txt'), true);
            assert.strictEqual(isInsideWorkspace(ws.root, 'new/dir/ok.txt'), true);
        } finally {
            ws.done();
        }
    });
});

describe('ワークスペースへの反映', () => {
    const fetchFrom = (files: Record<string, string>) => async (paths: string[]) =>
        new Map(paths.filter((p) => p in files).map((p) => [p, Buffer.from(files[p])]));

    test('違うファイルだけ書き、記録したことのあるファイルで view に無いものは消し、利用者のファイルは残す', async () => {
        const ws = tempWorkspace();
        try {
            fs.writeFileSync(path.join(ws.root, 'same.txt'), 'S');
            fs.writeFileSync(path.join(ws.root, 'old.txt'), 'OLD');
            fs.writeFileSync(path.join(ws.root, 'gone.txt'), 'G');
            fs.writeFileSync(path.join(ws.root, 'user-only.txt'), 'U');
            const guest = { 'same.txt': 'S', 'old.txt': 'NEW', 'dir/new.txt': 'N' };
            const r = await syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: ['d\tdir', f('dir/new.txt', 'N'), f('old.txt', 'NEW'), f('same.txt', 'S')],
                managedFiles: ['same.txt', 'old.txt', 'gone.txt', 'dir/new.txt'],
                fetchFiles: fetchFrom(guest),
                traits: hostTraitsFor(process.platform),
            });
            assert.deepStrictEqual(r.written.sort(), ['dir/new.txt', 'old.txt']);
            assert.deepStrictEqual(r.deleted, ['gone.txt']);
            assert.strictEqual(r.unchanged, 1);
            assert.deepStrictEqual(r.rejected, []);
            assert.strictEqual(fs.readFileSync(path.join(ws.root, 'old.txt'), 'utf8'), 'NEW');
            assert.ok(fs.existsSync(path.join(ws.root, 'user-only.txt')));
            assert.ok(!fs.existsSync(path.join(ws.root, 'gone.txt')));
        } finally {
            ws.done();
        }
    });

    test('ゲストが一覧と違う中身を返したら書かない', async () => {
        const ws = tempWorkspace();
        try {
            const r = await syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: [f('a.txt', 'expected')],
                managedFiles: [],
                fetchFiles: fetchFrom({ 'a.txt': 'tampered' }),
                traits: linux,
            });
            assert.deepStrictEqual(r.written, []);
            assert.deepStrictEqual(r.rejected.map((x) => x.reason), ['hash-mismatch']);
            assert.ok(!fs.existsSync(path.join(ws.root, 'a.txt')));
        } finally {
            ws.done();
        }
    });

    test('.git やワークスペースの外を指すリンクの先には書かないし、消しもしない', async () => {
        const ws = tempWorkspace();
        try {
            linkDir(ws.outside, path.join(ws.root, 'escape'));
            fs.writeFileSync(path.join(ws.outside, 'victim.txt'), 'keep');
            fs.mkdirSync(path.join(ws.root, '.git'));
            const r = await syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: [f('.git/hooks/post-checkout', 'evil'), f('escape/pwned.txt', 'evil'), f('ok.txt', 'ok')],
                managedFiles: ['escape/victim.txt'],
                fetchFiles: fetchFrom({ '.git/hooks/post-checkout': 'evil', 'escape/pwned.txt': 'evil', 'ok.txt': 'ok' }),
                traits: linux,
            });
            assert.deepStrictEqual(r.written, ['ok.txt']);
            assert.deepStrictEqual(r.rejected.map((x) => [x.path, x.reason]).sort(), [
                ['.git/hooks/post-checkout', 'git-dir'],
                ['escape/pwned.txt', 'escapes-workspace'],
                ['escape/victim.txt', 'escapes-workspace'],
            ]);
            assert.ok(!fs.existsSync(path.join(ws.root, '.git', 'hooks')));
            assert.ok(!fs.existsSync(path.join(ws.outside, 'pwned.txt')));
            assert.strictEqual(fs.readFileSync(path.join(ws.outside, 'victim.txt'), 'utf8'), 'keep');
        } finally {
            ws.done();
        }
    });

    test('ファイル p → ディレクトリ p/ は、古い p を消してから置く。利用者のファイルがあるディレクトリは消さない', async () => {
        const ws = tempWorkspace();
        try {
            fs.writeFileSync(path.join(ws.root, 'p'), 'file');
            fs.mkdirSync(path.join(ws.root, 'userdir'));
            fs.writeFileSync(path.join(ws.root, 'userdir', 'mine.txt'), 'keep');
            const r = await syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: ['d\tp', f('p/q.txt', 'Q'), f('userdir', 'now a file')],
                managedFiles: ['p'],
                fetchFiles: fetchFrom({ 'p/q.txt': 'Q', userdir: 'now a file' }),
                traits: linux,
            });
            assert.deepStrictEqual(r.deleted, ['p']);
            assert.deepStrictEqual(r.written, ['p/q.txt']);
            assert.deepStrictEqual(r.rejected.map((x) => [x.path, x.reason]), [['userdir', 'type-conflict']]);
            assert.strictEqual(fs.readFileSync(path.join(ws.root, 'userdir', 'mine.txt'), 'utf8'), 'keep');
        } finally {
            ws.done();
        }
    });

    test('ディレクトリ p/ → ファイル p は、中のファイルを消して空になったディレクトリを片付けてから置く（#14 の差分テストで見つけた）', async () => {
        const ws = tempWorkspace();
        try {
            fs.mkdirSync(path.join(ws.root, 'p', 'sub'), { recursive: true });
            fs.writeFileSync(path.join(ws.root, 'p', 'q.txt'), 'Q');
            fs.writeFileSync(path.join(ws.root, 'p', 'sub', 'r.txt'), 'R');
            const r = await syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: [f('p', 'now a file')],
                managedFiles: ['p/q.txt', 'p/sub/r.txt', 'p'],
                fetchFiles: fetchFrom({ p: 'now a file' }),
                traits: linux,
            });
            assert.deepStrictEqual(r.deleted.sort(), ['p/q.txt', 'p/sub/r.txt']);
            assert.deepStrictEqual(r.written, ['p']);
            assert.deepStrictEqual(r.rejected, []);
            assert.strictEqual(fs.readFileSync(path.join(ws.root, 'p'), 'utf8'), 'now a file');
        } finally {
            ws.done();
        }
    });

    test('中身を取ってくる途中でゲストが落ちたら、ワークスペースには何もしない（#16 の受け入れ条件）', async () => {
        const ws = tempWorkspace();
        try {
            fs.writeFileSync(path.join(ws.root, 'gone.txt'), 'still here');
            fs.writeFileSync(path.join(ws.root, 'old.txt'), 'OLD');
            await assert.rejects(syncWorkspaceFromGuest({
                workspaceRoot: ws.root,
                viewLines: [f('old.txt', 'NEW'), f('new.txt', 'N')],
                managedFiles: ['gone.txt', 'old.txt'],
                fetchFiles: async () => { throw new Error('agent process exited (code=null signal=SIGKILL)'); },
                traits: linux,
            }), /SIGKILL/);
            // 消すはずだったファイルも、書き換えるはずだったファイルも、そのまま
            assert.strictEqual(fs.readFileSync(path.join(ws.root, 'gone.txt'), 'utf8'), 'still here');
            assert.strictEqual(fs.readFileSync(path.join(ws.root, 'old.txt'), 'utf8'), 'OLD');
            assert.ok(!fs.existsSync(path.join(ws.root, 'new.txt')));
        } finally {
            ws.done();
        }
    });

    test('2 回目は中身を取らない（キャッシュと sha256 で同じと分かる）', async () => {
        const ws = tempWorkspace();
        try {
            let fetched = 0;
            const opts = {
                workspaceRoot: ws.root,
                viewLines: [f('a.txt', 'A')],
                managedFiles: [],
                fetchFiles: async (paths: string[]) => { fetched += paths.length; return new Map(paths.map((p) => [p, Buffer.from('A')])); },
                traits: linux,
            };
            const first = await syncWorkspaceFromGuest(opts);
            const second = await syncWorkspaceFromGuest({ ...opts, cache: first.cache });
            assert.strictEqual(fetched, 1);
            assert.strictEqual(second.unchanged, 1);
            assert.deepStrictEqual(second.written, []);
        } finally {
            ws.done();
        }
    });
});
