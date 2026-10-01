/**
 * マイクロコミット（保存 1 回の記録）の Git の部分（#32）。
 *
 * extension.ts の runShadowCommit から、振る舞いを変えずに切り出した。VS Code に依存しないので、
 * ベンチ（scripts/bench-micro-commit.mjs）と、新しい実装との差分テストから直接呼べる。
 *
 * 前提：保存したファイルの中身は、呼ぶ前に shadow の作業ツリーに書いてある。
 *
 * この実装（Git の CLI を呼ぶ版）は、保存 1 回で Git のプロセスを 15 回前後起動し、
 * findPastCommitForSave は履歴全体を読む（#32 で測って置き換える対象）。
 */

export type GitRunner = {
    /** 失敗したら例外 */
    run(cwd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): string;
    /** 失敗したら undefined */
    tryRun(cwd: string, args: string[]): string | undefined;
};

export type MicroCommitInput = {
    shadowRepoPath: string;
    /** shadow の作業ツリーからの相対パス（/ 区切り） */
    relativeFilePath: string;
    /** いま記録しているマイクロブランチの先端のタグ（mb-N） */
    currentTag: string;
    /** 新しいコミットを作るときだけ呼ぶ（メインの HEAD を読むなど費用がかかるため） */
    message: () => string;
    /** commit-tree に渡す環境（作者・日時） */
    commitEnv: NodeJS.ProcessEnv;
};

export type PastCommitMatch = {
    commit: string;
    /** tree: ワークツリー全体が一致 / file: 保存ファイルの内容のみ過去と一致（Ctrl+Z・手編集戻し） */
    reason: 'tree' | 'file';
};

/**
 * 新しいコミットが親から何を変えたか（速い記録だけが付ける。#37）。層の作成で Git を起動せずに済ませるため。
 * 付けるのは「変わったのが保存したファイル 1 つだけで、消えたファイルが無い」ときだけ
 */
export type MicroCommitDelta = {
    parent: string;
    files: Array<{ path: string; mode: '100644' | '100755'; content: Buffer }>;
};

export type MicroCommitOutcome =
    | { kind: 'unchanged' }
    | { kind: 'rewound'; commit: string; reason: 'tree' | 'file'; tag: string }
    | { kind: 'created'; commit: string; parent?: string; tag: string; delta?: MicroCommitDelta };

/** コミットハッシュまたは mb-* タグのみ許可 */
export function isSafeGitRef(ref: string): boolean {
    return /^[0-9a-f]{4,40}$/i.test(ref) || /^mb-\d+$/.test(ref);
}

/**
 * 保存内容が過去コミットと一致するか調べる。
 * 1) 全体 tree 一致（完全な過去状態）
 * 2) 保存ファイルの blob 一致（1ファイルだけ Ctrl+Z / 手編集で戻した場合）
 */
export function findPastCommitForSave(
    git: GitRunner,
    shadowRepoPath: string,
    relativeFilePath: string,
    currentTreeHash: string,
): PastCommitMatch | undefined {
    const treeLog = git.run(shadowRepoPath, ['log', '--all', '--format=%H %T']).trim().split('\n').filter(Boolean);
    for (const line of treeLog) {
        const [cHash, tHash] = line.split(' ');
        if (tHash === currentTreeHash && isSafeGitRef(cHash)) {
            return { commit: cHash, reason: 'tree' };
        }
    }

    const currentBlob = git.tryRun(shadowRepoPath, ['hash-object', '--', relativeFilePath])?.trim();
    if (!currentBlob || !/^[0-9a-f]{40}$/i.test(currentBlob)) {
        return undefined;
    }

    const fileLog = git.run(shadowRepoPath, ['log', '--all', '--format=%H', '--', relativeFilePath])
        .trim()
        .split('\n')
        .filter(Boolean);
    for (const cHash of fileLog) {
        if (!isSafeGitRef(cHash)) { continue; }
        // パス区切りは toPosixRelative 済み。rev-parse の tree:path 形式で blob を取得する
        const blob = git.tryRun(shadowRepoPath, ['rev-parse', '--verify', `${cHash}:${relativeFilePath}`])?.trim();
        if (blob === currentBlob) {
            return { commit: cHash, reason: 'file' };
        }
    }
    return undefined;
}

export function getNextTagCode(git: GitRunner, shadowRepoPath: string): string {
    try {
        const stdout = git.run(shadowRepoPath, ['tag', '-l', 'mb-*']);
        const tags = stdout.trim().split('\n').filter(Boolean);
        let maxNum = 0;
        for (const tag of tags) {
            const match = tag.match(/^mb-(\d+)$/);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) { maxNum = num; }
            }
        }
        return `mb-${maxNum + 1}`;
    } catch {
        return 'mb-1';
    }
}

/** Git の CLI で 1 回の保存を記録する（5.0.0 までの実装） */
export function recordMicroCommitViaGitCli(git: GitRunner, input: MicroCommitInput): MicroCommitOutcome {
    const { shadowRepoPath, relativeFilePath } = input;
    let tag = input.currentTag;

    // detached HEAD のままだと以降の記録が不安定なので、コミット前にブランチへ戻す
    const microHistoryRef = git.tryRun(shadowRepoPath, ['rev-parse', '--verify', 'refs/heads/micro-history']);
    const headSymbolic = git.tryRun(shadowRepoPath, ['symbolic-ref', '-q', 'HEAD']);
    if (microHistoryRef && !headSymbolic) {
        const headHash = git.tryRun(shadowRepoPath, ['rev-parse', 'HEAD'])?.trim();
        git.run(shadowRepoPath, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
        if (headHash && isSafeGitRef(headHash)) {
            git.run(shadowRepoPath, ['update-ref', 'refs/heads/micro-history', headHash]);
        }
    }

    git.run(shadowRepoPath, ['add', '--', relativeFilePath]);
    const currentTreeHash = git.run(shadowRepoPath, ['write-tree']).trim();
    if (!/^[0-9a-f]{40}$/i.test(currentTreeHash)) {
        throw new Error('不正な tree ハッシュです');
    }

    const hasCommits = git.tryRun(shadowRepoPath, ['rev-parse', '--verify', 'HEAD']) !== undefined;

    let currentHead = '';
    if (hasCommits) {
        currentHead = git.run(shadowRepoPath, ['rev-parse', 'HEAD']).trim();
        const headTree = git.tryRun(shadowRepoPath, ['rev-parse', 'HEAD^{tree}'])?.trim() ?? '';
        // tip と同じ tree → 過去探索・commit-tree を省略
        if (headTree && headTree === currentTreeHash) {
            return { kind: 'unchanged' };
        }
    }

    // 以前と同じ変更（同一 tree / 同一ファイル内容）→ 新規コミットも新 mb-* も作らず HEAD だけ戻す
    const pastMatch = hasCommits
        ? findPastCommitForSave(git, shadowRepoPath, relativeFilePath, currentTreeHash)
        : undefined;

    if (pastMatch && currentHead !== pastMatch.commit) {
        git.run(shadowRepoPath, ['update-ref', 'refs/heads/micro-history', pastMatch.commit]);
        git.run(shadowRepoPath, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);

        // mb-* はブランチ先端にだけ付く。先端へ戻ったときだけアクティブブランチを切替。
        const attachedTag = git.tryRun(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*'])?.trim();
        if (attachedTag) {
            tag = attachedTag.split('\n')[0];
        }
        return { kind: 'rewound', commit: pastMatch.commit, reason: pastMatch.reason, tag };
    }
    if (pastMatch && currentHead === pastMatch.commit) {
        return { kind: 'unchanged' };
    }

    const commitTreeArgs = ['commit-tree', currentTreeHash];
    if (currentHead) {
        if (!isSafeGitRef(currentHead)) {
            throw new Error('不正な parent ハッシュです');
        }
        commitTreeArgs.push('-p', currentHead);
    }
    commitTreeArgs.push('-m', input.message());

    const commitHash = git.run(shadowRepoPath, commitTreeArgs, { env: input.commitEnv }).trim();
    if (!isSafeGitRef(commitHash)) {
        throw new Error('不正な commit ハッシュです');
    }

    git.run(shadowRepoPath, ['update-ref', 'refs/heads/micro-history', commitHash]);
    git.run(shadowRepoPath, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);

    // mb-* は各マイクロブランチの先端にだけ付ける（タグ数 = ブランチ数）。
    // 同一ブランチ上の前進 → 先端タグを -f で移動。先端以外から保存 → 新ブランチ mb-N。
    if (!isSafeGitRef(tag)) {
        tag = 'mb-1';
    }
    const tipOfCurrentTag = git.tryRun(shadowRepoPath, ['rev-parse', tag])?.trim();
    if (currentHead && tipOfCurrentTag && currentHead !== tipOfCurrentTag) {
        const nextTag = getNextTagCode(git, shadowRepoPath);
        git.run(shadowRepoPath, ['tag', nextTag, commitHash]);
        tag = nextTag;
    } else {
        git.run(shadowRepoPath, ['tag', '-f', tag, commitHash]);
    }
    return { kind: 'created', commit: commitHash, parent: currentHead || undefined, tag };
}
