/**
 * テキストとバイナリの差分（ほかのドライバが当てはまらないとき）。
 * テキストは中身の差分を返さず、表示は VS Code の差分エディタに任せる（kind: 'text'）。
 * バイナリは大きさだけ返す。テキストかどうかは、両方の版の先頭 8 KiB に NUL が無く、UTF-8 として読めるかで決める。
 */
import { BinaryDiff, DiffDriver, DiffInput, TextDiff, baseOf } from './types';

/** バイト列がテキストらしいか（先頭 8 KiB に NUL が無く、UTF-8 として壊れていない） */
export function looksLikeText(b: Buffer | undefined): boolean {
    if (!b) { return true; }
    const head = b.subarray(0, 8192);
    if (head.includes(0)) { return false; }
    // 末尾で多バイト文字が切れていることがあるので、最後の 3 バイトは見ない
    const s = head.subarray(0, Math.max(0, head.length - 3)).toString('utf8');
    return !s.includes('�');
}

export const textDriver: DiffDriver = {
    id: 'text',
    version: 1,
    label: 'テキスト',
    matches: (_p, head) => looksLikeText(head),
    async diff(input: DiffInput): Promise<TextDiff> {
        if (!looksLikeText(input.oldBytes) || !looksLikeText(input.newBytes)) {
            return (await binaryDriver.diff(input, undefined as never)) as never;
        }
        const base = baseOf(textDriver, input);
        const lines = (b?: Buffer) => (b ? b.toString('utf8').split('\n').length : 0);
        const summary = base.status === 'added' ? `追加（${lines(input.newBytes)} 行）`
            : base.status === 'deleted' ? `削除（${lines(input.oldBytes)} 行）`
            : input.oldBytes!.equals(input.newBytes!) ? '変更なし' : 'テキストの変更（差分エディタで表示）';
        return { ...base, kind: 'text', summary, status: base.status === 'modified' && input.oldBytes!.equals(input.newBytes!) ? 'unchanged' : base.status };
    },
};

export const binaryDriver: DiffDriver = {
    id: 'binary',
    version: 1,
    label: 'バイナリ',
    matches: () => true,
    async diff(input: DiffInput): Promise<BinaryDiff> {
        const base = baseOf(binaryDriver, input);
        const same = !!input.oldBytes && !!input.newBytes && input.oldBytes.equals(input.newBytes);
        const fmt = (n?: number) => (n === undefined ? '-' : `${n.toLocaleString('en-US')} バイト`);
        const summary = base.status === 'added' ? `追加（${fmt(input.newBytes?.length)}）`
            : base.status === 'deleted' ? `削除（${fmt(input.oldBytes?.length)}）`
            : same ? '変更なし' : `バイト列の変更（${fmt(input.oldBytes?.length)} → ${fmt(input.newBytes?.length)}）。この形式の中身の差分には対応していない`;
        return { ...base, kind: 'binary', status: same ? 'unchanged' : base.status, summary, oldSize: input.oldBytes?.length, newSize: input.newBytes?.length };
    },
};
