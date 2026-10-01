/**
 * マイクロ履歴の永続性の水準（#11 の O-11、docs/adr/0002-durability.md）。
 *
 * Git の既定（core.fsync=committed,-loose-object）では、MicroGit が保存のたびに作る
 * ばらのオブジェクト（loose object）も ref も、ディスクへの書き込みを待たない。
 * VS Code や拡張機能が落ちても記録は残るが、OS ごと落ちる・電源が切れると、直前の記録が失われたり、
 * ref が存在しないオブジェクトを指してリポジトリが壊れたりしうる。
 *
 * - power（既定）: ばらのオブジェクトと ref を fsync する。電源断でも、保存ジョブが終わった記録は失わない。
 *   Windows で保存 1 回（add・write-tree・commit-tree・update-ref）が 99.9 → 106.9 ms（中央値、+7%）。
 *   時間のほとんどは Git のプロセスの起動で、fsync の分は小さい（2026-09-26 に計測）
 * - process: Git の既定のまま。プロセスが落ちても失わないが、電源断では直前の記録を失いうる
 *
 * core.fsyncMethod=batch は、ばらのオブジェクトをまとめて最後に 1 回だけディスクのキャッシュを
 * 書き出させる。Git 2.36 より古い Git はこれらのキーを知らないが、知らない設定キーは無視されるだけ。
 */
export type Durability = 'power' | 'process';

let current: Durability = 'power';

export function setDurability(value: unknown): void {
    current = value === 'process' ? 'process' : 'power';
}

export function getDurability(): Durability {
    return current;
}

/** git の先頭に付ける `-c` 引数 */
export function durabilityGitArgs(): string[] {
    if (current === 'process') { return []; }
    return ['-c', 'core.fsync=loose-object,reference', '-c', 'core.fsyncMethod=batch'];
}
