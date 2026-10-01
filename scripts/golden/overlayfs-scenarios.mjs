/**
 * OverlayFS ゴールデンテストのシナリオ（Issue #10）。
 * カーネル側（record-kernel.mjs）と Node 側（check-node.mjs）は、どちらもこの定義を読む。
 *
 * commits[i] = { parent?: number, ops: Op[] }
 *   parent を省略すると直前のコミットの子になる。最初のコミットは空の状態から始まる。
 *   同じ parent を持つコミットを 2 つ置くと、枝分かれ（FR-2 の branch）になる。
 *
 * Op:
 *   ['write', path, content]  ファイルを作る／上書きする（親ディレクトリは自動で作る）
 *   ['rm', path]              ファイルを消す
 *   ['rmdir', path]           ディレクトリを中身ごと消す
 *   ['mkdir', path]           ディレクトリを作る
 *   ['mv', from, to]          名前を変える（ファイルでもディレクトリでも）
 *
 * path は `/` 区切りの相対パス。content は印字可能な ASCII のみ（シェルにそのまま渡すため）。
 * シナリオを足したら record-kernel.mjs で期待値を取り直す。
 */
export const scenarios = [
    {
        name: 'add-files',
        about: '層を積んでも、下の層のファイルは見え続ける',
        commits: [
            { ops: [['write', 'a.txt', 'A1'], ['write', 'd/b.txt', 'B1']] },
            { ops: [['write', 'c.txt', 'C1']] },
        ],
    },
    {
        name: 'modify-file',
        about: '上の層で書き換えたファイルが、下の層の同じファイルを隠す（コピーアップ）',
        commits: [
            { ops: [['write', 'a.txt', 'v1'], ['write', 'd/b.txt', 'v1']] },
            { ops: [['write', 'a.txt', 'v2']] },
            { ops: [['write', 'd/b.txt', 'v3'], ['write', 'a.txt', '']] },
        ],
    },
    {
        name: 'delete-file',
        about: '下の層のファイルを消すと whiteout で見えなくなる。中身が空になったディレクトリは残る',
        commits: [
            { ops: [['write', 'a.txt', 'A'], ['write', 'd/b.txt', 'B'], ['write', 'd/c.txt', 'C']] },
            { ops: [['rm', 'a.txt']] },
            { ops: [['rm', 'd/b.txt'], ['rm', 'd/c.txt']] },
        ],
    },
    {
        name: 'delete-dir',
        about: 'ディレクトリを中身ごと消すと、ディレクトリ自体も見えなくなる',
        commits: [
            { ops: [['write', 'd/x.txt', 'X'], ['write', 'd/sub/y.txt', 'Y'], ['write', 'keep.txt', 'K']] },
            { ops: [['rmdir', 'd']] },
        ],
    },
    {
        name: 'recreate-dir',
        about: 'ディレクトリを消して同じ名前で作り直すと、下の層の中身は見えない（opaque ディレクトリ）',
        commits: [
            { ops: [['write', 'd/x.txt', 'X'], ['write', 'd/y.txt', 'Y']] },
            { ops: [['rmdir', 'd'], ['write', 'd/z.txt', 'Z']] },
        ],
    },
    {
        name: 'rename-file',
        about: 'ファイルの名前を変える',
        commits: [
            { ops: [['write', 'a.txt', 'A'], ['write', 'd/b.txt', 'B']] },
            { ops: [['mv', 'a.txt', 'renamed.txt'], ['mv', 'd/b.txt', 'b.txt']] },
        ],
    },
    {
        name: 'rename-dir',
        about: '下の層にあるディレクトリの名前を変える（redirect_dir の設定が効く）',
        commits: [
            { ops: [['write', 'd/x.txt', 'X'], ['write', 'd/sub/y.txt', 'Y']] },
            { ops: [['mv', 'd', 'e']] },
            { ops: [['write', 'e/sub/z.txt', 'Z']] },
        ],
    },
    {
        name: 'file-to-dir',
        about: '同じ名前のファイルをディレクトリに置き換える',
        commits: [
            { ops: [['write', 'p', 'file']] },
            { ops: [['rm', 'p'], ['write', 'p/q.txt', 'Q']] },
        ],
    },
    {
        name: 'dir-to-file',
        about: '同じ名前のディレクトリをファイルに置き換える',
        commits: [
            { ops: [['write', 'p/q.txt', 'Q']] },
            { ops: [['rmdir', 'p'], ['write', 'p', 'file']] },
        ],
    },
    {
        name: 'empty-dir',
        about: '空のディレクトリ（Git は空ディレクトリを記録しない）',
        commits: [
            { ops: [['mkdir', 'empty'], ['write', 'a.txt', 'A']] },
        ],
    },
    {
        name: 'sibling-branches',
        about: '同じ親から分けた 2 本の枝は、互いの変更を見ない（FR-2 の branch）',
        commits: [
            { ops: [['write', 'a.txt', 'base'], ['write', 'keep.txt', 'K']] },
            { parent: 0, ops: [['write', 'a.txt', 'A'], ['write', 'only-a.txt', 'A']] },
            { parent: 0, ops: [['write', 'a.txt', 'B'], ['rm', 'keep.txt']] },
            { parent: 1, ops: [['write', 'a2.txt', 'A2']] },
        ],
    },
    {
        name: 'whiteout-lookalike-name',
        about: '`.wh.` で始まる普通のファイル。カーネルの whiteout はデバイスファイルなので、名前とは衝突しない',
        commits: [
            { ops: [['write', 'note.txt', 'N'], ['write', '.wh.note.txt', 'not a whiteout']] },
            { ops: [['write', 'd/.wh.x', 'W']] },
        ],
    },
];

/** i 番目のコミットの親の番号（最初のコミットは -1） */
export function parentOf(scenario, i) {
    const c = scenario.commits[i];
    return c.parent ?? i - 1;
}

/** 最初のコミットから i 番目のコミットまでの番号の列（下の層が先） */
export function chainOf(scenario, i) {
    const chain = [];
    for (let n = i; n >= 0; n = parentOf(scenario, n)) {
        chain.unshift(n);
    }
    return chain;
}

export function validateScenarios() {
    const names = new Set();
    for (const s of scenarios) {
        if (!/^[a-z0-9-]+$/.test(s.name) || names.has(s.name)) {
            throw new Error(`bad or duplicate scenario name: ${s.name}`);
        }
        names.add(s.name);
        s.commits.forEach((c, i) => {
            const p = parentOf(s, i);
            if (p >= i || (i > 0 && p < 0)) {
                throw new Error(`${s.name}: commit ${i + 1} has invalid parent ${p}`);
            }
            for (const op of c.ops) {
                const paths = op[0] === 'write' ? [op[1]] : op.slice(1);
                for (const rel of paths) {
                    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.')) {
                        throw new Error(`${s.name}: bad path ${rel}`);
                    }
                }
                if (op[0] === 'write' && !/^[\x20-\x7e]*$/.test(op[2])) {
                    throw new Error(`${s.name}: content must be printable ASCII`);
                }
            }
        });
    }
}
