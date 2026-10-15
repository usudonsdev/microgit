/** マイクロコミットとメイン HEAD の紐づけ（Main-Head trailer） */

/** マイクロコミットのメッセージ末尾に付ける trailer のキー。 */
export const MAIN_HEAD_TRAILER = 'Main-Head';

/** メインの Git のコミット 1 つ（区間の選択肢を作る入力）。 */
export interface MainCommitInfo {
    hash: string;
    subject: string;
}

/** パネルの「メインコミット区間」の選択肢 1 つ。 */
export interface MainIntervalOption {
    /** 'all' | 'unclassified' | フルハッシュ */
    id: string;
    label: string;
    /** null=すべて、''=未分類、それ以外=その Main-Head に一致 */
    mainHead: string | null;
}

/** 40 桁の 16 進数（大文字小文字を区別しない）に当てはまる正規表現。完全なコミットハッシュの判定に使う。短縮ハッシュは trailer に書かない（buildMicroCommitMessage）。 */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** `Main-Head: <sha>` の 1 行を作る。 */
export function formatMainHeadTrailer(sha: string): string {
    return `${MAIN_HEAD_TRAILER}: ${sha}`;
}

/** subject / body から Main-Head trailer を取り出す */
export function parseMainHeadFromMessage(subject: string, body = ''): string | undefined {
    const text = `${subject}\n${body}`;
    const m = text.match(new RegExp(`^${MAIN_HEAD_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, 'im'));
    if (!m?.[1]) {
        return undefined;
    }
    return m[1].toLowerCase();
}

/**
 * マイクロコミットのメッセージを作る。件名は `micro: [AI] saved <パス> at <時刻>`（AI の編集のとき [AI] が付く）。
 * mainHead が 40 桁の完全なハッシュのときだけ、空行のあとに Main-Head trailer を付ける（それ以外は黙って付けない）。
 */
export function buildMicroCommitMessage(
    relativeFilePath: string,
    fromAi: boolean,
    mainHead?: string,
): string {
    const timestamp = new Date().toISOString();
    const subject = fromAi
        ? `micro: [AI] saved ${relativeFilePath} at ${timestamp}`
        : `micro: saved ${relativeFilePath} at ${timestamp}`;
    if (mainHead && FULL_SHA.test(mainHead)) {
        return `${subject}\n\n${formatMainHeadTrailer(mainHead)}`;
    }
    return subject;
}

/** ハッシュを先頭 len 文字に縮める。未指定・空のときは `-`。 */
export function shortHash(hash: string | undefined, len = 7): string {
    if (!hash) {
        return '-';
    }
    return hash.substring(0, len);
}

/** 件名の空白を 1 つにまとめて max 文字以内に切る。切ったときは末尾を `…` にする。 */
function truncateSubject(subject: string, max = 40): string {
    const s = subject.replace(/\s+/g, ' ').trim();
    if (s.length <= max) {
        return s;
    }
    return `${s.slice(0, max - 1)}…`;
}

/**
 * メイン log（新しい順）から UI 用の区間オプションを作る。
 * Main-Head = A のマイクロは「A の上での作業」＝ A → 次のメインコミット（またはいまの作業）。
 */
export function buildMainIntervalOptions(
    mainCommitsNewestFirst: MainCommitInfo[],
    microMainHeads: Array<string | undefined>,
): MainIntervalOption[] {
    const options: MainIntervalOption[] = [
        { id: 'all', label: 'すべて（ブランチ全体）', mainHead: null },
    ];

    const seenMicro = new Set(
        microMainHeads
            .filter((h): h is string => typeof h === 'string' && h.length > 0)
            .map((h) => h.toLowerCase()),
    );
    const hasUnclassified = microMainHeads.some((h) => !h);

    for (let i = 0; i < mainCommitsNewestFirst.length; i++) {
        const base = mainCommitsNewestFirst[i];
        const baseLower = base.hash.toLowerCase();
        const newer = i === 0 ? undefined : mainCommitsNewestFirst[i - 1];
        const range = newer
            ? `${shortHash(base.hash)} → ${shortHash(newer.hash)}`
            : `${shortHash(base.hash)} → いまの作業`;
        const label = `${range}  ${truncateSubject(base.subject || '(no subject)')}`;
        // 現在 HEAD、または実際にマイクロが紐づく区間だけ出す
        if (i === 0 || seenMicro.has(baseLower)) {
            options.push({
                id: baseLower,
                label,
                mainHead: baseLower,
            });
        }
    }

    // メイン log に無い Main-Head（rebase 後など）
    const listed = new Set(options.map((o) => o.id));
    for (const h of seenMicro) {
        if (!listed.has(h)) {
            options.push({
                id: h,
                label: `${shortHash(h)} → ?（ログ外）`,
                mainHead: h,
            });
        }
    }

    if (hasUnclassified) {
        options.push({
            id: 'unclassified',
            label: '未分類（Main-Head なし）',
            mainHead: '',
        });
    }

    return options;
}

/**
 * コミットを Main-Head の区間で絞る。null は絞らない、空文字は Main-Head の無いもの、
 * それ以外はその Main-Head に一致するもの（大文字小文字を区別しない）。
 */
export function filterCommitsByMainInterval<T extends { mainHead?: string }>(
    commits: T[],
    intervalMainHead: string | null,
): T[] {
    if (intervalMainHead === null) {
        return commits;
    }
    if (intervalMainHead === '') {
        return commits.filter((c) => !c.mainHead);
    }
    const want = intervalMainHead.toLowerCase();
    return commits.filter((c) => (c.mainHead || '').toLowerCase() === want);
}
