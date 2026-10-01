import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    OVERLAY_DIR,
    checkoutLayers,
    collectShadowTrackedFiles,
    computePath,
    describeOverlayEngine,
    ensureLayerExists,
    ensureOverlayDirs,
    exportCommitLayer,
    isOverlayCheckoutEnabled,
    readDag,
    removeFromWriteLayer,
    syncMergeToWorkspace,
    updateDagCurrent,
    writeLayerDir,
} from './overlay';
import { BackendSelector, parseBackendSetting } from './kernel/backendSelector';
import { ensureExecutable } from './kernel/executable';
import { FastMicroCommitter } from './fastMicroCommit';
import { SaveTimer, SaveTimingLog } from './saveTiming';
import { firstTagAtHead, readRef, readSymbolicHead, resolveGitDir } from './fastGit/refs';
import { recoverJournals } from './fastGit/journal';
import { GitRunner, isSafeGitRef, MicroCommitInput, MicroCommitOutcome, recordMicroCommitViaGitCli } from './microCommit';
import { findInPath, KernelSettings, planLaunch } from './kernel/launchers';
import {
    ensureShadowRepoForBranch,
    fetchMicrogitRefsFromOrigin,
    importFromParentRefs,
    publishToParentRefs,
    pushMicrogitRefsToOrigin,
    sanitizeBranchKey as sanitizeBranchKeyShared,
} from './shadowStore';
import {
    buildMainIntervalOptions,
    buildMicroCommitMessage,
    parseMainHeadFromMessage,
} from './mainHead';
import { MicroGitUi, MicroGitUiSnapshot } from './ui';
import { durabilityGitArgs, getDurability, setDurability } from './durability';

const STATE_ENABLED = 'microgit.enabled';
const STATE_TARGET_BRANCH = 'microgit.targetBranch';
const ARTIFACT_DIRS = ['.microgit_shadow', '.microgit_logs', OVERLAY_DIR] as const;

/** 現在ユーザーがどのタイムライン（マイクロブランチ）の延長線上にいるか */
let currentMicroBranchTag: string = 'mb-1';

let extensionContext: vscode.ExtensionContext | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let microGitUi: MicroGitUi | undefined;
let saveChain: Promise<void> = Promise.resolve();
/** キュー上に残っている保存ジョブ数（同一内容の畳み込み判定に使う） */
let pendingSaveJobs = 0;
/** 直前に観測したメインブランチ名（専属マイクロ空間の載せ替え用） */
let lastKnownBranch: string | undefined;
/** 直近エンキューした保存ジョブ（キュー未消化中の同一内容連続保存を畳む） */
let lastEnqueuedSave: { absPath: string; contentHash: string } | undefined;
/** 親 refs への publish を間引く */
let publishTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPublishJob: { rootPath: string; branch: string } | undefined;
const PUBLISH_DEBOUNCE_MS = 1500;
/**
 * 保存のあとの後片付け（画面の更新、timeline.log、log_latest.json）。保存の処理の列の中でやると、
 * 1 回 200 ms 前後かかって次の保存を待たせていた（#37 の計測）。保存が続く間はまとめ、落ち着いてから 1 回だけ行う
 */
const AFTER_SAVE_REFRESH_MS = 300;
let afterSaveTimer: ReturnType<typeof setTimeout> | undefined;
let afterSaveJob: { rootPath: string; savedFile?: string } | undefined;
/** 最後に記録した保存の結果（Overlay の状態の更新で、git rev-parse HEAD を起動しないため。#37） */
let lastSaveOutcome: { head: string; layerByKernel: boolean } | undefined;
/** Overlay のバックエンド（カーネル版か Node.js 版か）を選ぶ（#14、docs/kernel-backend.md） */
let backendSelector: BackendSelector | undefined;

/**
 * 設定から Backend Selector を作る。カーネル版は必要になるまで起動しない（最初の保存か、過去に戻る操作のとき）。
 * 設定 microgit.overlayBackend: auto（既定）/ kernel / nodejs。microgit.kernel.*: QEMU の場所・動かし方・メモリ。
 */
function createBackendSelector(context: vscode.ExtensionContext): BackendSelector {
    const cfg = vscode.workspace.getConfiguration();
    const accel = cfg.get<string>('microgit.kernel.accel');
    const settings: KernelSettings = {
        qemuPath: cfg.get<string>('microgit.kernel.qemuPath') || undefined,
        accel: accel === 'whpx' || accel === 'tcg' ? accel : 'auto',
        memoryMb: cfg.get<number>('microgit.kernel.memoryMb') || 256,
    };
    const logDir = context.logUri.fsPath;
    return new BackendSelector({
        setting: parseBackendSetting(cfg.get('microgit.overlayBackend')),
        plan: () => {
            fs.mkdirSync(logDir, { recursive: true });
            return planLaunch({
                platform: process.platform,
                arch: process.arch,
                osRelease: os.release(),
                extensionPath: context.extensionPath,
                env: process.env,
                settings,
                logDir,
                exists: (p) => fs.existsSync(p),
                which: (cmd) => findInPath(cmd, process.env, process.platform, (p) => fs.existsSync(p)),
                // 同梱の agent・microgit-vm の実行ビット（VSIX で落ちることがある。#19）
                ensureExecutable: process.platform === 'win32' ? undefined : (p) => ensureExecutable(p, (m) => ExtensionLogger.log(m)),
            });
        },
        tryRunGit,
        log: (message, level) => ExtensionLogger.log(message, level),
        notify: (message) => { void vscode.window.showWarningMessage(`[MicroGit] ${message}`); },
    });
}

/**
 * 拡張機能がアクティブになった際に呼び出されるエントリポイント
 */
export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    ExtensionLogger.initialize('MicroGit Output');
    ExtensionLogger.log('MicroGit 拡張機能が起動しました');

    setDurability(vscode.workspace.getConfiguration().get('microgit.durability'));
    ExtensionLogger.log(`マイクロ履歴の永続性: ${getDurability()}`);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('microgit.durability')) {
                setDurability(vscode.workspace.getConfiguration().get('microgit.durability'));
                ExtensionLogger.log(`マイクロ履歴の永続性を変更: ${getDurability()}`);
            }
            if (e.affectsConfiguration('microgit.overlayBackend') || e.affectsConfiguration('microgit.kernel')) {
                // 設定が変わったら作り直す。動いていたカーネル版は止める（次に必要になったとき新しい設定で起動する）
                const old = backendSelector;
                backendSelector = createBackendSelector(context);
                void old?.dispose();
                ExtensionLogger.log(`Overlay のバックエンドの設定を変更: ${backendSelector.setting}`);
            }
        })
    );

    backendSelector = createBackendSelector(context);
    ExtensionLogger.log(`Overlay のバックエンド: ${backendSelector.setting}（カーネル版は必要になったときに起動する）`);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    statusBarItem.name = 'MicroGit';
    statusBarItem.text = '$(circle-slash) MicroGit: OFF';
    statusBarItem.command = 'microgit.toggle';
    statusBarItem.tooltip = 'MicroGit の有効 / 無効を切り替え';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    microGitUi = new MicroGitUi(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MicroGitUi.viewType, microGitUi, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        syncBranchPolicy(rootPath);
        if (isActiveOnCurrentBranch(rootPath)) {
            const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
            if (fs.existsSync(shadowRepoPath)) {
                currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
                ExtensionLogger.log(`前回のアクティブマイクロブランチを引き継ぎました: ${currentMicroBranchTag}`);
            }
        }
        void ExtensionLogger.exportLogFile(rootPath);
        refreshUi(rootPath);
    } else {
        refreshUi(undefined);
    }

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            const absPath = document.uri.fsPath;

            if (isMicroGitArtifactPath(absPath, rootPath)) { return; }
            if (!isPathInsideRoot(absPath, rootPath)) { return; }

            if (!syncBranchPolicy(rootPath)) {
                refreshUi(rootPath);
                return;
            }

            const gitPath = path.join(rootPath, '.git');
            const isTestFile = absPath.endsWith('test_dummy.py');
            if (!fs.existsSync(gitPath) && !isTestFile) {
                ExtensionLogger.log('Git管理外のフォルダのため、処理をスキップしました。', 'WARN');
                void ExtensionLogger.exportLogFile(rootPath);
                return;
            }

            // 発行時点の内容を固定（実行時のディスク／ジャンプ後状態に引きずられない）
            const snapshot = captureSaveSnapshot(document);
            const contentHash = createHash('sha1').update(snapshot).digest('hex');

            // キュー消化前の同一パス・同一内容の連続エンキューだけ畳む
            if (
                pendingSaveJobs > 0 &&
                lastEnqueuedSave &&
                lastEnqueuedSave.absPath === absPath &&
                lastEnqueuedSave.contentHash === contentHash
            ) {
                ExtensionLogger.log(`同一内容のため保存ジョブを省略: ${absPath}`);
                return;
            }
            lastEnqueuedSave = { absPath, contentHash };

            ExtensionLogger.log(`ファイル保存イベントを検知（スナップショット）: ${absPath}`);

            const enqueuedBranch = getCurrentBranch(rootPath);
            pendingSaveJobs++;
            // 段階ごとの時間（#37）。保存のイベントの時刻から数える
            const timer = new SaveTimer(performance.now());
            let saveResult = 'skipped';
            enqueueSave(async () => {
                timer.mark('queue');
                try {
                    // 実行時点でブランチ／有効状態を再確認（投入後に切替されても誤記録しない）
                    if (!syncBranchPolicy(rootPath)) {
                        ExtensionLogger.log('保存ジョブ実行時: 記録不可のためスキップ', 'WARN');
                        refreshUi(rootPath);
                        return;
                    }
                    const runningBranch = getCurrentBranch(rootPath);
                    if (enqueuedBranch && runningBranch && enqueuedBranch !== runningBranch) {
                        ExtensionLogger.log(
                            `保存ジョブ実行時: ブランチが変わったためスキップ（${enqueuedBranch} → ${runningBranch}）`,
                            'WARN'
                        );
                        refreshUi(rootPath);
                        return;
                    }

                    timer.mark('policy');
                    lastSaveOutcome = undefined;
                    const result = await runShadowCommit(rootPath, absPath, snapshot, timer);
                    saveResult = result;
                    if ((result === 'created' || result === 'rewound') && useOverlayCheckout()) {
                        // 新しいコミットのときは何もしない。ワークスペースはもう保存した内容で、層は runShadowCommit で
                        // 書き出してある（カーネル版は agent に、Node.js 版は .microgit_overlay/layers に）。
                        // Node.js 版は以前ここで「過去の姿のビュー」を作り直していて、保存のたびに 0.5〜0.6 秒かかっていた（#41）。
                        // ビューは、過去に戻るときに、いちばん近い展開済みのビューから必要な層だけ当てて作る。
                        // 同じ中身に戻した（rewound）ときは、ワークスペースを合わせるので今までどおり。HEAD は記録した結果から取る（#37）
                        const outcome = lastSaveOutcome as { head: string; layerByKernel: boolean } | undefined;
                        if (result === 'rewound') {
                            const head = outcome?.head ?? tryRunGit(path.join(rootPath, '.microgit_shadow'), ['rev-parse', 'HEAD'])?.trim();
                            if (head) {
                                await applyOverlayCheckout(rootPath, head, { syncWorkspace: result === 'rewound' });
                            }
                        }
                        timer.mark('overlay');
                    }
                    // 画面・timeline.log・log_latest.json は列の外で、まとめて（#37）
                    scheduleAfterSaveRefresh(rootPath, result === 'created' || result === 'rewound' ? absPath : undefined);
                    timer.skip();
                } finally {
                    saveTimings.add(timer.finish(saveResult));
                    pendingSaveJobs = Math.max(0, pendingSaveJobs - 1);
                    if (pendingSaveJobs === 0) {
                        lastEnqueuedSave = undefined;
                    }
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.toggle', async () => {
            if (!workspaceFolders) {
                vscode.window.showWarningMessage('ワークスペースを開いてから MicroGit を切り替えてください。');
                return;
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (isEnabled()) {
                await setEnabled(false);
                syncBranchPolicy(rootPath);
                vscode.window.showInformationMessage('[MicroGit] 無効にしました。各ブランチのマイクロ履歴は保持されます。');
                ExtensionLogger.log('MicroGit を無効化しました');
            } else {
                const branch = getCurrentBranch(rootPath);
                if (!branch || branch === 'HEAD') {
                    vscode.window.showErrorMessage('有効なブランチ上でのみ MicroGit を有効化できます（detached HEAD 不可）。');
                    return;
                }
                await setEnabled(true);
                syncBranchPolicy(rootPath);
                vscode.window.showInformationMessage(
                    `[MicroGit] 有効化しました。ブランチごとに専属のマイクロ履歴を使います（現在: ${branch}）`
                );
                ExtensionLogger.log(`MicroGit を有効化しました。現在ブランチ: ${branch}`);
            }
            refreshUi(rootPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.openPanel', async () => {
            await vscode.commands.executeCommand(`${MicroGitUi.viewType}.focus`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.enable', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (isEnabled()) {
                const branch = getCurrentBranch(rootPath) ?? getActiveMicroSpaceBranch() ?? '未設定';
                vscode.window.showInformationMessage(`[MicroGit] 既に有効です（現在のマイクロ空間: ${branch}）`);
                refreshUi(rootPath);
                return;
            }
            await vscode.commands.executeCommand('microgit.toggle');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.disable', async () => {
            if (!workspaceFolders) { return; }
            if (!isEnabled()) {
                vscode.window.showInformationMessage('[MicroGit] 既に無効です');
                refreshUi(workspaceFolders[0].uri.fsPath);
                return;
            }
            await vscode.commands.executeCommand('microgit.toggle');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.jumpToCommit', async (explicitTarget?: string) => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            if (!syncBranchPolicy(rootPath)) {
                refreshUi(rootPath);
                vscode.window.showWarningMessage('MicroGit が無効、または記録可能なブランチ上にいないためタイムトラベルできません。');
                return;
            }
            const target = explicitTarget || await vscode.window.showInputBox({
                prompt: '戻りたいコミットハッシュ、またはタグ名を入力',
                placeHolder: 'mb-1'
            });
            if (!target) { return; }
            await sharedTimeTravel(target.trim(), rootPath);
            refreshUi(rootPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.exportLogs', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            syncBranchPolicy(rootPath);
            if (!isOnTargetBranch(rootPath)) {
                vscode.window.showWarningMessage('記録可能なブランチ上でのみログをエクスポートできます。');
                return;
            }
            try {
                await ExtensionLogger.exportLogFile(rootPath);
                vscode.window.showInformationMessage('[MicroGit] ログファイルを正常にエクスポートしました！');
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`ログのエクスポートに失敗しました: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.showGraph', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            syncBranchPolicy(rootPath);
            refreshUi(rootPath);
            microGitUi?.showGraphPanel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.publishMicroHistory', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            const branch = getCurrentBranch(rootPath);
            if (!isEnabled() || !isRecordableBranch(branch)) {
                vscode.window.showWarningMessage('有効かつ名前付きブランチ上でのみ publish できます。');
                return;
            }
            try {
                ensureShadowRepoForBranch(rootPath, branch!, (m, l) => ExtensionLogger.log(m, l));
                publishToParentRefs(rootPath, branch!, (m, l) => ExtensionLogger.log(m, l));
                const pushed = pushMicrogitRefsToOrigin(rootPath, (m, l) => ExtensionLogger.log(m, l));
                vscode.window.showInformationMessage(
                    pushed
                        ? `[MicroGit] 親 refs と origin の refs/microgit/* へ同期しました（${branch}）`
                        : `[MicroGit] 親 refs へ publish しました（origin への push はスキップまたは失敗）`
                );
                refreshUi(rootPath);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`[MicroGit] publish に失敗: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('microgit.fetchMicroHistory', async () => {
            if (!workspaceFolders) { return; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            const branch = getCurrentBranch(rootPath);
            if (!isEnabled() || !isRecordableBranch(branch)) {
                vscode.window.showWarningMessage('有効かつ名前付きブランチ上でのみ fetch できます。');
                return;
            }
            try {
                fetchMicrogitRefsFromOrigin(rootPath, (m, l) => ExtensionLogger.log(m, l));
                const result = importFromParentRefs(rootPath, branch!, (m, l) => ExtensionLogger.log(m, l));
                reloadMicroTagFromShadow(rootPath);
                if (result.outcome === 'diverged' && result.forkTag) {
                    vscode.window.showWarningMessage(
                        `[MicroGit] 他デバイスの履歴が発散していたため、新しい分岐として取り込みました（${result.forkTag}）。現在の作業は変更していません。`
                    );
                } else {
                    vscode.window.showInformationMessage(`[MicroGit] refs/microgit を取り込みました（${branch}・${result.outcome}）`);
                }
                refreshUi(rootPath);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`[MicroGit] fetch に失敗: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        // テストと計測のための内部コマンド（package.json には出さない。#37）
        vscode.commands.registerCommand('microgit.internal.waitForSaves', async () => { await saveChain; }),
        vscode.commands.registerCommand('microgit.internal.flushAfterSave', async () => { await saveChain; await flushAfterSaveRefresh(); }),
        vscode.commands.registerCommand('microgit.internal.saveTimings', (clear?: boolean) => {
            const all = [...saveTimings.all];
            if (clear) { saveTimings.clear(); }
            return all;
        }),
        vscode.commands.registerCommand('microgit.overlayStatus', async () => {
            const kernelText = backendSelector ? await backendSelector.describe() : 'overlayBackend=?';
            const active = backendSelector?.readyKernel() ? 'kernel' : 'nodejs';
            const text =
                `active=${active}\n` +
                `useOverlayCheckout=${useOverlayCheckout()}\n` +
                `durability=${getDurability()}\n` +
                `microCommit=fast:${recorderStats.fast} git:${recorderStats.git}` +
                `${recorderStats.lastFallback ? ` (Git のコマンドにした理由: ${recorderStats.lastFallback})` : ''}\n` +
                `fastCommit: ${[...fastCommitters.values()].map((f) => `reloads=${f.stats.reloads} indexReloads=${f.stats.indexReloads} gitSpawns=${f.stats.gitSpawns} last=${Object.entries(f.stats.lastPhases).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(",")}`).join(' / ') || '-'}\n\n` +
                `${saveTimings.describe()}\n\n` +
                `[kernel backend]\n${kernelText}\n\n` +
                `[nodejs backend（フォールバック）]\n${describeOverlayEngine()}`;
            ExtensionLogger.log(`[Overlay status]\n${text}`);
            vscode.window.showInformationMessage(`[MicroGit Overlay] ${active}`);
            await vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument({ content: text, language: 'text' }),
                { preview: true }
            );
        })
    );

    watchGitBranchChanges(context, () => {
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        syncBranchPolicy(rootPath);
        refreshUi(rootPath);
    });
}

/** ステータスバーと専用 UI（サイドバー / グラフ）を最新状態へ同期する */
function refreshUi(rootPath: string | undefined): void {
    updateStatusBar(rootPath);
    microGitUi?.update(buildUiSnapshot(rootPath));
}

function buildUiSnapshot(rootPath: string | undefined): MicroGitUiSnapshot {
    if (!rootPath) {
        return {
            enabled: isEnabled(),
            targetBranch: getActiveMicroSpaceBranch(),
            onTarget: false,
            active: false,
            currentTag: currentMicroBranchTag,
            commits: [],
            hasShadow: false,
            workspaceOpen: false,
        };
    }

    const currentBranch = getCurrentBranch(rootPath);
    const microSpace = getActiveMicroSpaceBranch() ?? currentBranch;
    const onRecordable = isRecordableBranch(currentBranch);
    const active = isEnabled() && onRecordable;
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const hasShadow = fs.existsSync(path.join(shadowRepoPath, '.git')) || fs.existsSync(shadowRepoPath);
    let commits: MicroGitUiSnapshot['commits'] = [];
    let currentHead: string | undefined;

    if (active && hasShadow) {
        commits = getMicroGraphData(shadowRepoPath);
        currentHead = tryRunGit(shadowRepoPath, ['rev-parse', 'HEAD'])?.trim();
    }

    const mainCommits = getMainCommitLog(rootPath, 40);
    const mainIntervals = buildMainIntervalOptions(
        mainCommits,
        commits.map((c) => c.mainHead),
    );

    return {
        enabled: isEnabled(),
        targetBranch: microSpace,
        currentBranch,
        onTarget: onRecordable,
        active,
        currentTag: currentMicroBranchTag,
        currentHead,
        commits,
        mainIntervals,
        hasShadow: active && hasShadow,
        workspaceOpen: true,
    };
}

/** 保存のあとの後片付けを予約する。保存が続く間は後ろへずらし、落ち着いてから 1 回だけ行う（#37） */
function scheduleAfterSaveRefresh(rootPath: string, savedFile?: string): void {
    afterSaveJob = { rootPath, savedFile: savedFile ?? afterSaveJob?.savedFile };
    if (afterSaveTimer) { clearTimeout(afterSaveTimer); }
    afterSaveTimer = setTimeout(() => {
        const job = afterSaveJob;
        afterSaveJob = undefined;
        afterSaveTimer = undefined;
        if (!job) { return; }
        // 保存の処理が走っていないときに行う（列に積むと、その間の保存を待たせる）
        void (async () => {
            // ジャーナルに溜まった分の Git のファイルを確定させ、ジャーナルを消す（ADR-0014。保存の時間には入らない）
            await checkpointFastCommitters();
            if (job.savedFile) { await generateMicroGitFileLog(job.rootPath, job.savedFile); }
            await ExtensionLogger.exportLogFile(job.rootPath);
            refreshUi(job.rootPath);
        })();
    }, AFTER_SAVE_REFRESH_MS);
}

/** 予約した後片付けを今すぐ行う（テスト用） */
async function flushAfterSaveRefresh(): Promise<void> {
    const job = afterSaveJob;
    if (afterSaveTimer) { clearTimeout(afterSaveTimer); }
    afterSaveJob = undefined;
    afterSaveTimer = undefined;
    if (!job) { return; }
    await checkpointFastCommitters();
    if (job.savedFile) { await generateMicroGitFileLog(job.rootPath, job.savedFile); }
    await ExtensionLogger.exportLogFile(job.rootPath);
    refreshUi(job.rootPath);
}

function enqueueSave(task: () => Promise<void>): void {
    saveChain = saveChain.then(task, task);
}

/** 保存のたびに親 refs へ push しない。連続保存は最後の1回に間引く */
function schedulePublishToParent(rootPath: string, branch: string): void {
    pendingPublishJob = { rootPath, branch };
    if (publishTimer) {
        clearTimeout(publishTimer);
    }
    publishTimer = setTimeout(() => {
        const job = pendingPublishJob;
        pendingPublishJob = undefined;
        publishTimer = undefined;
        if (!job) { return; }
        try {
            publishToParentRefs(job.rootPath, job.branch, (m, l) => ExtensionLogger.log(m, l));
        } catch (pubErr: unknown) {
            const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
            ExtensionLogger.log(`親 refs への publish に失敗: ${msg}`, 'WARN');
        }
    }, PUBLISH_DEBOUNCE_MS);
}

/** onDidSave 時点のファイル内容を固定する（以降のディスク変化の影響を受けない） */
function captureSaveSnapshot(document: vscode.TextDocument): Buffer {
    try {
        // 保存完了後なのでディスクが正本。バイナリもそのまま取れる。
        return fs.readFileSync(document.uri.fsPath);
    } catch {
        return Buffer.from(document.getText(), 'utf8');
    }
}

function isEnabled(): boolean {
    return extensionContext?.workspaceState.get<boolean>(STATE_ENABLED, false) ?? false;
}

/** UI / 状態表示用: いま載せているマイクロ空間のメインブランチ名 */
function getActiveMicroSpaceBranch(): string | undefined {
    return extensionContext?.workspaceState.get<string>(STATE_TARGET_BRANCH);
}

async function setActiveMicroSpaceBranch(branch: string | undefined): Promise<void> {
    if (!extensionContext) { return; }
    await extensionContext.workspaceState.update(STATE_TARGET_BRANCH, branch);
}

async function setEnabled(enabled: boolean): Promise<void> {
    if (!extensionContext) { return; }
    await extensionContext.workspaceState.update(STATE_ENABLED, enabled);
}

function isRecordableBranch(branch: string | undefined): boolean {
    return Boolean(branch && branch !== 'HEAD');
}

function sanitizeBranchKey(branch: string): string {
    return sanitizeBranchKeyShared(branch);
}

/**
 * メインの各ブランチに専属のマイクロ空間を載せ替える。
 * - ブランチ切替時: 前ブランチの成果物を退避し、新ブランチの空間を復元
 * - detached HEAD: 記録せず、直前ブランチの空間を退避
 * 戻り値は「自動記録してよい」（有効かつ名前付きブランチ上）ときのみ true。
 */
function syncBranchPolicy(rootPath: string): boolean {
    const currentBranch = getCurrentBranch(rootPath);

    if (!isEnabled()) {
        lastKnownBranch = currentBranch;
        updateStatusBar(rootPath);
        return false;
    }

    if (!isRecordableBranch(currentBranch)) {
        if (isRecordableBranch(lastKnownBranch)) {
            stashMicroGitArtifacts(rootPath, lastKnownBranch!);
            ExtensionLogger.log(`detached HEAD のためマイクロ空間を退避しました（${lastKnownBranch}）`, 'WARN');
            void setActiveMicroSpaceBranch(undefined);
        }
        lastKnownBranch = currentBranch;
        updateStatusBar(rootPath);
        return false;
    }

    const previous = lastKnownBranch;
    if (isRecordableBranch(previous) && previous !== currentBranch) {
        stashMicroGitArtifacts(rootPath, previous!);
        restoreMicroGitArtifacts(rootPath, currentBranch!);
        prepareShadowForBranch(rootPath, currentBranch!, true);
        ExtensionLogger.log(`マイクロ空間を切替: ${previous} → ${currentBranch}`);
    } else if (previous !== currentBranch) {
        restoreMicroGitArtifacts(rootPath, currentBranch!);
        prepareShadowForBranch(rootPath, currentBranch!, true);
        ExtensionLogger.log(`マイクロ空間を装着: ${currentBranch}`);
    } else {
        // 同じブランチ: gitfile / bare の存在だけ保証（親 refs の再 import はしない）
        prepareShadowForBranch(rootPath, currentBranch!, false);
    }

    lastKnownBranch = currentBranch;
    void setActiveMicroSpaceBranch(currentBranch);
    updateStatusBar(rootPath);
    return true;
}

/** bare + gitfile を用意。importFromParent=true のとき親 refs/microgit から取り込む */
function prepareShadowForBranch(rootPath: string, mainBranch: string, importFromParent: boolean): void {
    try {
        // 保存のたびに（同じブランチで importFromParent=false）ここを通るので、ジャーナルのチェックポイントと作り直しは、
        // shadow を付け替える・親から取り込むときだけにする（保存のたびにすると、毎回ジャーナルを閉じて確定させてしまい、
        // 次の保存が新しいジャーナルを作る＝ディレクトリの fsync が 1 回増える。CI の Linux・macOS で fsync が 2 回になった）
        if (importFromParent) { checkpointShadowSync(path.join(rootPath, '.microgit_shadow')); } // 付け替える前の shadow の分
        ensureShadowRepoForBranch(rootPath, mainBranch, (m, l) => ExtensionLogger.log(m, l));
        if (importFromParent) { recoverShadowJournals(path.join(rootPath, '.microgit_shadow')); }
        if (importFromParent) {
            importFromParentRefs(rootPath, mainBranch, (m, l) => ExtensionLogger.log(m, l));
        }
        reloadMicroTagFromShadow(rootPath);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`シャドウ準備に失敗: ${message}`, 'ERROR');
    }
}

function reloadMicroTagFromShadow(rootPath: string): void {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    if (fs.existsSync(path.join(shadowRepoPath, '.git')) || fs.existsSync(shadowRepoPath)) {
        try {
            currentMicroBranchTag = detectCurrentTag(shadowRepoPath);
        } catch {
            currentMicroBranchTag = 'mb-1';
        }
    } else {
        currentMicroBranchTag = 'mb-1';
    }
}

function isOnTargetBranch(rootPath: string): boolean {
    return isEnabled() && isRecordableBranch(getCurrentBranch(rootPath));
}

function isActiveOnCurrentBranch(rootPath: string): boolean {
    return isOnTargetBranch(rootPath);
}

function getArtifactStashRoot(mainBranch: string): string {
    if (!extensionContext) {
        throw new Error('Extension context is not initialized');
    }
    const safeBranch = sanitizeBranchKey(mainBranch);
    const base = extensionContext.storageUri?.fsPath
        ?? path.join(extensionContext.globalStorageUri.fsPath, 'default-workspace');
    return path.join(base, 'branch-stash', safeBranch);
}

function moveDirectory(src: string, dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
    }
    try {
        fs.renameSync(src, dest);
    } catch {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
}

/** ブランチ専属空間を作業ツリーから拡張機能ストレージへ退避する */
function stashMicroGitArtifacts(rootPath: string, mainBranch: string): void {
    const stashRoot = getArtifactStashRoot(mainBranch);
    for (const dirName of ARTIFACT_DIRS) {
        const src = path.join(rootPath, dirName);
        if (!fs.existsSync(src)) { continue; }
        try {
            moveDirectory(src, path.join(stashRoot, dirName));
            ExtensionLogger.log(`退避しました [${mainBranch}]: ${dirName}`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            ExtensionLogger.log(`${dirName} の退避に失敗しました: ${message}`, 'ERROR');
        }
    }
}

/** ブランチ専属のマイクロ空間を作業ツリーへ戻す */
function restoreMicroGitArtifacts(rootPath: string, mainBranch: string): void {
    const stashRoot = getArtifactStashRoot(mainBranch);
    for (const dirName of ARTIFACT_DIRS) {
        const src = path.join(stashRoot, dirName);
        if (!fs.existsSync(src)) { continue; }
        try {
            moveDirectory(src, path.join(rootPath, dirName));
            ExtensionLogger.log(`復元しました [${mainBranch}]: ${dirName}`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            ExtensionLogger.log(`${dirName} の復元に失敗しました: ${message}`, 'ERROR');
        }
    }
}

function updateStatusBar(rootPath: string | undefined): void {
    if (!statusBarItem) { return; }

    const current = rootPath ? getCurrentBranch(rootPath) : undefined;

    if (!isEnabled()) {
        statusBarItem.text = '$(circle-slash) MicroGit: OFF';
        statusBarItem.backgroundColor = undefined;
        return;
    }

    if (isRecordableBranch(current)) {
        statusBarItem.text = `$(check) MicroGit: ${current}`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(warning) MicroGit: detached';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function getCurrentBranch(repoPath: string): string | undefined {
    // ふつうのリポジトリなら .git/HEAD を直接読む（保存のたびに Git を起動しない。#32）。
    // git rev-parse --abbrev-ref HEAD と同じく、detached なら 'HEAD' を返す
    try {
        const gitDir = resolveGitDir(repoPath);
        if (!fs.existsSync(path.join(gitDir, 'commondir'))) {
            const sym = readSymbolicHead(gitDir);
            if (sym?.startsWith('refs/heads/')) { return sym.slice('refs/heads/'.length); }
            if (!sym && readRef(gitDir, 'HEAD')) { return 'HEAD'; }
        }
    } catch { /* 下の git に任せる */ }
    try {
        const branch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        return branch || undefined;
    } catch {
        return undefined;
    }
}

function watchGitBranchChanges(context: vscode.ExtensionContext, onChange: () => void): void {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) { return; }

    const attach = (api: { repositories: Array<{ state: { onDidChange: (listener: () => void) => vscode.Disposable } }>; onDidOpenRepository: (listener: (repo: { state: { onDidChange: (listener: () => void) => vscode.Disposable } }) => void) => vscode.Disposable }) => {
        for (const repo of api.repositories) {
            context.subscriptions.push(repo.state.onDidChange(onChange));
        }
        context.subscriptions.push(api.onDidOpenRepository((repo) => {
            context.subscriptions.push(repo.state.onDidChange(onChange));
        }));
    };

    const tryAttach = (): boolean => {
        try {
            if (!gitExtension.isActive) { return false; }
            const api = gitExtension.exports?.getAPI?.(1);
            if (!api) { return false; }
            attach(api);
            return true;
        } catch {
            return false;
        }
    };

    if (!tryAttach()) {
        void gitExtension.activate().then(() => {
            tryAttach();
            onChange();
        });
    }
}

/**
 * 引数配列で git を実行し、シェルインジェクションを避ける
 */
function runGit(
    cwd: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv }
): string {
    // core.quotepath=false: 既定（true）では --name-only などが日本語などのパスを "\343\203\241..." のように
    // エスケープして出し、それをパスとして使うと別のファイルを指してしまう（#21 の N-6）
    // durabilityGitArgs: 保存の記録（commit-tree・update-ref など）を、設定した永続性の水準で書く（#11 の O-11）
    return execFileSync('git', ['-c', 'core.quotepath=false', ...durabilityGitArgs(), ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: options?.env ?? process.env,
    }).toString();
}

function tryRunGit(cwd: string, args: string[]): string | undefined {
    try {
        return runGit(cwd, args);
    } catch {
        return undefined;
    }
}

/** microCommit.ts に渡す Git の呼び出し（#32） */
const gitRunner: GitRunner = { run: runGit, tryRun: tryRunGit };

/** shadow の Git のディレクトリごとの速い記録（#32）。ブランチを切り替えると shadow の指す bare が変わるので、bare で分ける */
const fastCommitters = new Map<string, FastMicroCommitter>();
/** 速い記録を使えなかった理由（同じ理由を何度も出さない） */
const fastFallbackReasons = new Set<string>();
/** Overlay Status に出す：どちらで何回記録したか、最後に Git のコマンドにした理由 */
const recorderStats = { fast: 0, git: 0, lastFallback: '', last: '' as '' | 'fast' | 'git' };
/** 保存 1 回ごとの段階ごとの時間（#37）。Overlay Status に出す */
const saveTimings = new SaveTimingLog(200);
/** 直近の速い記録の段階ごとの時間（保存の計測の記録に載せる。#45） */
let lastCommitPhases: Record<string, number> | undefined;

/** すべての速い記録のジャーナルを、裏でチェックポイントする（ADR-0014） */
async function checkpointFastCommitters(): Promise<void> {
    await Promise.all([...fastCommitters.values()].map((fc) => fc.checkpoint().catch((e: unknown) => {
        ExtensionLogger.log(`[記録] ジャーナルのチェックポイントに失敗（次の起動で作り直します）: ${e instanceof Error ? e.message : String(e)}`, 'WARN');
    })));
}

/**
 * 速い記録を通らずに shadow の ref を書き換える前に呼ぶ（ADR-0014）。ジャーナルを空にしておけば、
 * 停電のあとの作り直しが、その書き換えをジャーナルの古い値で上書きすることはない
 */
function checkpointShadowSync(shadowRepoPath: string): void {
    try {
        fastCommitters.get(resolveGitDir(shadowRepoPath))?.checkpointSync();
    } catch (e) {
        ExtensionLogger.log(`[記録] ジャーナルのチェックポイントに失敗: ${e instanceof Error ? e.message : String(e)}`, 'WARN');
    }
}

/**
 * shadow を開くときに、前に停電などで止まったときのジャーナルから作り直す（ADR-0014）。
 * 速い記録も最初の保存のときに作り直すが、保存より先に履歴を見る・過去に戻ることがあるので、ここでも行う
 */
function recoverShadowJournals(shadowRepoPath: string): void {
    try {
        if (!fs.existsSync(shadowRepoPath)) { return; }
        const r = recoverJournals(resolveGitDir(shadowRepoPath));
        if (r.objectsRepaired || r.refsAdvanced || r.headRepaired || r.indexReset || r.reflogsRepaired || r.truncatedTails) {
            ExtensionLogger.log(`[記録] 前回止まったときのジャーナルから作り直しました: ${JSON.stringify(r)}`, 'WARN');
        }
    } catch (e) {
        ExtensionLogger.log(`[記録] ジャーナルからの作り直しに失敗: ${e instanceof Error ? e.message : String(e)}`, 'ERROR');
    }
}

/**
 * 1 回の保存を記録する。設定 microgit.fastMicroCommit（既定 true）なら、Git のプロセスを起動しない速い実装
 * （fastMicroCommit.ts）で記録し、前提から外れたときや失敗したときは Git の CLI の実装で記録する（#32）
 */
function recordMicroCommit(input: MicroCommitInput): MicroCommitOutcome {
    if (vscode.workspace.getConfiguration().get<boolean>('microgit.fastMicroCommit') !== false) {
        let gitDir = '';
        try {
            gitDir = resolveGitDir(input.shadowRepoPath);
            let fc = fastCommitters.get(gitDir);
            if (!fc) {
                fc = new FastMicroCommitter(input.shadowRepoPath, () => getDurability() === 'power');
                fastCommitters.set(gitDir, fc);
            }
            const out = fc.record(input);
            lastCommitPhases = { ...fc.stats.lastPhases };
            recorderStats.fast++;
            recorderStats.last = 'fast';
            return out;
        } catch (e) {
            // Git のコマンドで記録する前に、ジャーナルの分を確定させて空にする（作り直しと食い違わないように）
            try { fastCommitters.get(gitDir)?.checkpointSync(); } catch { /* 確定できなくても、次の起動で作り直す */ }
            fastCommitters.get(gitDir)?.invalidate();
            const reason = e instanceof Error ? e.message : String(e);
            recorderStats.lastFallback = reason;
            if (!fastFallbackReasons.has(reason)) {
                fastFallbackReasons.add(reason);
                ExtensionLogger.log(`[記録] 速い記録を使わず Git のコマンドで記録します: ${reason}`, 'WARN');
            }
        }
    }
    recorderStats.git++;
    recorderStats.last = 'git';
    return recordMicroCommitViaGitCli(gitRunner, input);
}

/** メインのリポジトリの HEAD のコミット。ファイルを直接読み、読めなければ git rev-parse（#32。保存のたびに Git を起動しない） */
function readMainHead(mainRepoPath: string): string | undefined {
    try {
        const v = readRef(resolveGitDir(mainRepoPath), 'HEAD');
        if (v) { return v; }
    } catch { /* 下の git に任せる */ }
    return tryRunGit(mainRepoPath, ['rev-parse', 'HEAD'])?.trim();
}

function toPosixRelative(rootPath: string, absolutePath: string): string | undefined {
    if (!isPathInsideRoot(absolutePath, rootPath)) { return undefined; }
    const relative = path.relative(rootPath, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return undefined; }
    return relative.split(path.sep).join('/');
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(rootPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function isSafeRepoRelativePath(relPath: string, rootPath: string): boolean {
    if (!relPath || path.isAbsolute(relPath)) { return false; }
    const normalized = path.normalize(relPath);
    if (normalized.split(path.sep).includes('..')) { return false; }
    return isPathInsideRoot(path.resolve(rootPath, normalized), rootPath);
}

function isMicroGitArtifactPath(filePath: string, rootPath: string): boolean {
    const resolved = path.resolve(filePath);
    return ARTIFACT_DIRS.some((dirName) => {
        const artifactRoot = path.join(rootPath, dirName);
        return resolved === artifactRoot || resolved.startsWith(artifactRoot + path.sep);
    });
}

async function generateMicroGitFileLog(rootPath: string, savedFilePath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const fileName = path.basename(savedFilePath);
    const logFolderPath = path.join(rootPath, '.microgit_logs');
    const logFilePath = path.join(logFolderPath, 'timeline.log');

    try {
        if (!fs.existsSync(shadowRepoPath)) { return; }

        const logOutput = runGit(shadowRepoPath, [
            'log',
            '--graph',
            '--all',
            '--oneline',
            '--decorate',
            '--date=short'
        ]);

        const logContent = `[MicroGit タイムライン履歴 - ${fileName}]\n同期時刻: ${new Date().toLocaleString()}\n現在のタグ: ${currentMicroBranchTag}\n\n${logOutput}`;

        if (!fs.existsSync(logFolderPath)) {
            fs.mkdirSync(logFolderPath, { recursive: true });
        }

        fs.writeFileSync(logFilePath, logContent, 'utf8');
        ExtensionLogger.log(`.microgit_logs/timeline.log を自動更新しました (${fileName})`);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`ログ生成に失敗しました: ${message}`, 'ERROR');
    }
}

function useOverlayCheckout(): boolean {
    return isOverlayCheckoutEnabled((key) =>
        vscode.workspace.getConfiguration().get<boolean>(key)
    );
}

const AI_PENDING_FILE = path.join('.microgit_logs', 'ai-pending.json');

/** Cursor Agent / Tab 編集でマークされたパスなら true を返し、pending から外す */
function consumeAiPending(rootPath: string, relativeFilePath: string): boolean {
    const pendingPath = path.join(rootPath, AI_PENDING_FILE);
    try {
        if (!fs.existsSync(pendingPath)) { return false; }
        const raw = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as unknown;
        if (!Array.isArray(raw)) { return false; }
        const list = raw.filter((x): x is string => typeof x === 'string');
        const norm = relativeFilePath.replace(/\\/g, '/');
        const idx = list.findIndex((p) => p.replace(/\\/g, '/') === norm);
        if (idx < 0) { return false; }
        list.splice(idx, 1);
        fs.writeFileSync(pendingPath, JSON.stringify(list, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** 反映で中身が変わった文書を、開いているエディタで読み直す */
async function revertTouchedDocuments(rootPath: string, touched: Set<string>): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
        const rel = toPosixRelative(rootPath, doc.uri.fsPath);
        if (!rel || !touched.has(rel)) { continue; }
        try {
            await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
        } catch { /* ignore */ }
    }
}

/**
 * カーネル版で targetHash の時点にワークスペースを合わせる（#14）。
 * 使えた・終わったら true。使えない・失敗したら false（呼び出し側が Node 版で続ける）。
 * ゲストから受け取ったものは Boundary Guard（src/boundaryGuard.ts）を通してから書く。
 */
async function applyKernelCheckout(rootPath: string, targetHash: string): Promise<boolean> {
    const selector = backendSelector;
    if (!selector?.wantsKernel) { return false; }
    const kernel = await selector.ensureKernel();
    if (!kernel) { return false; }

    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const paths = ensureOverlayDirs(rootPath);
    // 消してよいのは MicroGit が記録したことのあるパスだけ（Node 版の syncMergeToWorkspace と同じ範囲）
    const managed = new Set([...readDag(paths).managedFiles, ...collectShadowTrackedFiles(shadowRepoPath, tryRunGit)]);
    try {
        const result = await kernel.checkout({
            workspaceRoot: rootPath,
            shadowRepo: shadowRepoPath,
            target: targetHash,
            managedFiles: managed,
            cacheFile: path.join(paths.meta, 'kernel-sync-cache.json'),
        });
        updateDagCurrent(paths, targetHash, currentMicroBranchTag);
        await revertTouchedDocuments(rootPath, new Set([...result.written, ...result.deleted]));
        const t = result.timings;
        ExtensionLogger.log(
            `[Overlay/kernel] ${targetHash.substring(0, 7)} ${result.ensure.snapshot ? '写しの層' : '差分の層'} depth=${result.ensure.depth} ` +
            `written=${result.written.length} deleted=${result.deleted.length} unchanged=${result.unchanged} rejected=${result.rejected.length} ` +
            `ensure=${t.ensureMs}ms view=${t.viewMs}ms sync=${t.syncMs}ms total=${t.totalMs}ms`
        );
        if (result.rejected.length) {
            for (const r of result.rejected) {
                ExtensionLogger.log(`[Overlay/kernel] 反映しなかった: ${r.path}（${r.reason}${r.detail ? `: ${r.detail}` : ''}）`, 'WARN');
            }
            void vscode.window.showWarningMessage(
                `[MicroGit] ${result.rejected.length} 件のファイルは、この PC では安全に書けないため反映しませんでした（詳細は MicroGit Output）`
            );
        }
        return true;
    } catch (err: unknown) {
        selector.reportError(err);
        return false;
    }
}

/**
 * computePath → checkoutLayers（ユーザー空間 materialize）→ workspace 同期（Node.js 版）。
 * カーネル版が使えるときは、先にカーネル版で試す（applyKernelCheckout）。
 */
async function applyOverlayCheckout(
    rootPath: string,
    targetHash: string,
    options?: { syncWorkspace?: boolean },
): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');
    const syncWorkspace = options?.syncWorkspace !== false;

    if (syncWorkspace) {
        if (await applyKernelCheckout(rootPath, targetHash)) { return; }
    } else if (backendSelector?.readyKernel()) {
        // 保存の直後: カーネル版は保存のときに層を作ってある（runShadowCommit）。ワークスペースはもう保存した内容なので何もしない
        return;
    }

    const paths = ensureOverlayDirs(rootPath);
    writeLayerDir(paths, currentMicroBranchTag);

    const layerPath = computePath(shadowRepoPath, targetHash, runGit, tryRunGit);
    for (const hash of layerPath) {
        ensureLayerExists(shadowRepoPath, paths, hash, runGit, tryRunGit);
    }

    const result = checkoutLayers(paths, layerPath, currentMicroBranchTag);
    updateDagCurrent(paths, targetHash, currentMicroBranchTag);

    if (!syncWorkspace) {
        ExtensionLogger.log(
            `[Overlay/${result.backend}] merge 更新のみ method=${result.method} ` +
            `applied=${result.appliedLayers} files=${result.fileCount} ` +
            `path=${layerPath.map((h) => h.substring(0, 7)).join('→')} write=${currentMicroBranchTag}`
        );
        return;
    }

    const { written, deleted, skipped, conflicts } = syncMergeToWorkspace(
        rootPath,
        paths,
        isSafeRepoRelativePath,
        isMicroGitArtifactPath,
        collectShadowTrackedFiles(shadowRepoPath, tryRunGit),
    );

    await revertTouchedDocuments(rootPath, new Set([...written, ...deleted]));

    ExtensionLogger.log(
        `[Overlay/${result.backend}] method=${result.method} applied=${result.appliedLayers} ` +
        `path=${layerPath.map((h) => h.substring(0, 7)).join('→')} ` +
        `write=${currentMicroBranchTag} written=${written.length} deleted=${deleted.length} skipped=${skipped} conflicts=${conflicts.length} ` +
        `(${describeOverlayEngine()})`
    );
    for (const rel of conflicts) {
        ExtensionLogger.log(`[Overlay/nodejs] 反映しなかった（利用者のファイルやディレクトリとぶつかる）: ${rel}`, 'WARN');
    }
}

async function sharedTimeTravel(target: string, rootPath: string): Promise<void> {
    const shadowRepoPath = path.join(rootPath, '.microgit_shadow');

    if (!isSafeGitRef(target)) {
        vscode.window.showErrorMessage('不正なコミット参照です。ハッシュまたは mb-* タグのみ指定できます。');
        return;
    }

    if (!fs.existsSync(shadowRepoPath)) {
        vscode.window.showWarningMessage('シャドウリポジトリがありません。');
        return;
    }

    try {
        const targetHash = runGit(shadowRepoPath, ['rev-parse', target]).trim();
        if (!isSafeGitRef(targetHash)) {
            throw new Error('コミット参照を解決できませんでした');
        }
        checkpointShadowSync(shadowRepoPath);
        runGit(shadowRepoPath, ['update-ref', 'refs/heads/micro-history', targetHash]);
        runGit(shadowRepoPath, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);

        if (target.startsWith('mb-')) {
            currentMicroBranchTag = target;
        } else {
            const attachedTag = tryRunGit(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*'])?.trim();
            if (attachedTag) {
                currentMicroBranchTag = attachedTag.split('\n')[0];
            }
        }

        if (useOverlayCheckout()) {
            await applyOverlayCheckout(rootPath, targetHash, { syncWorkspace: true });
        } else {
            const affectedFilesStr = runGit(shadowRepoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim();
            const affectedFiles = affectedFilesStr.split('\n').filter(Boolean);

            if (affectedFiles.length === 0) {
                const allFilesStr = runGit(shadowRepoPath, ['ls-tree', '--name-only', '-r', 'HEAD']).trim();
                affectedFiles.push(...allFilesStr.split('\n').filter(Boolean));
            }

            for (const relPath of affectedFiles) {
                if (!isSafeRepoRelativePath(relPath, rootPath)) {
                    ExtensionLogger.log(`不正なパスをスキップしました: ${relPath}`, 'WARN');
                    continue;
                }
                const targetWorkspacePath = path.join(rootPath, relPath);
                try {
                    const fileContent = execFileSync('git', ['show', `HEAD:${relPath}`], {
                        cwd: shadowRepoPath,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true,
                    });
                    if (!fs.existsSync(path.dirname(targetWorkspacePath))) {
                        fs.mkdirSync(path.dirname(targetWorkspacePath), { recursive: true });
                    }
                    fs.writeFileSync(targetWorkspacePath, fileContent);
                } catch {
                    if (fs.existsSync(targetWorkspacePath)) {
                        fs.unlinkSync(targetWorkspacePath);
                    }
                }
            }
        }

        vscode.window.showInformationMessage(`[MicroGit] ${target} の状態に一発復元しました！`);
        ExtensionLogger.log(`[タイムトラベル] ${target} の時点に復元。現在のアクティブタグ: ${currentMicroBranchTag}`);
        await ExtensionLogger.exportLogFile(rootPath);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`タイムトラベルに失敗しました: ${message}`);
    }
}

type ShadowCommitResult = 'created' | 'unchanged' | 'rewound' | 'skipped' | 'error';

/** 現在のメインブランチ向けに bare+gitfile シャドウを用意する */
function ensureShadowRepo(mainRepoPath: string): void {
    const branch = getCurrentBranch(mainRepoPath);
    if (!isRecordableBranch(branch)) {
        throw new Error('記録可能なブランチ上でのみシャドウを初期化できます');
    }
    ensureShadowRepoForBranch(mainRepoPath, branch!, (m, l) => ExtensionLogger.log(m, l));
}

async function runShadowCommit(
    mainRepoPath: string,
    savedFilePath: string,
    snapshotContent: Buffer,
    timer?: SaveTimer,
): Promise<ShadowCommitResult> {
    const relativeFilePath = toPosixRelative(mainRepoPath, savedFilePath);
    if (!relativeFilePath) {
        ExtensionLogger.log(`ワークスペース外のファイルのためスキップ: ${savedFilePath}`, 'WARN');
        return 'skipped';
    }

    const shadowRepoPath = path.join(mainRepoPath, '.microgit_shadow');
    const shadowFilePath = path.join(shadowRepoPath, ...relativeFilePath.split('/'));

    if (!isPathInsideRoot(shadowFilePath, shadowRepoPath)) {
        ExtensionLogger.log(`不正なシャドウパスのためスキップ: ${relativeFilePath}`, 'WARN');
        return 'skipped';
    }

    try {
        ensureShadowRepo(mainRepoPath);
        timer?.mark('ensure');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`シャドウ初期化に失敗しました: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`[MicroGit] シャドウ初期化に失敗しました: ${message}`);
        return 'error';
    }

    if (!fs.existsSync(path.dirname(shadowFilePath))) {
        fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });
    }
    try {
        // 実行時ディスクではなく、ジョブ発行時スナップショットを書く
        fs.writeFileSync(shadowFilePath, snapshotContent);
        timer?.mark('write');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`シャドウへの書き込みに失敗しました: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`[MicroGit] ファイル書き込みに失敗しました: ${message}`);
        return 'error';
    }

    try {
        // Git の部分は microCommit.ts（#32。VS Code に依存しないので、ベンチと差分テストから呼べる）
        const outcome = recordMicroCommit({
            shadowRepoPath,
            relativeFilePath,
            currentTag: currentMicroBranchTag,
            message: () => {
                const fromAi = consumeAiPending(mainRepoPath, relativeFilePath);
                const mainHeadAtSave = readMainHead(mainRepoPath);
                return buildMicroCommitMessage(
                    relativeFilePath,
                    fromAi,
                    mainHeadAtSave && isSafeGitRef(mainHeadAtSave) ? mainHeadAtSave : undefined,
                );
            },
            commitEnv: {
                ...process.env,
                GIT_AUTHOR_NAME: 'MicroGit',
                GIT_AUTHOR_EMAIL: 'microgit@local',
                GIT_COMMITTER_NAME: 'MicroGit',
                GIT_COMMITTER_EMAIL: 'microgit@local',
            },
        });
        timer?.mark('commit');
        timer?.recorded();
        if (timer) {
            timer.timing.recorder = recorderStats.last;
            if (recorderStats.last === 'fast') { timer.timing.commitPhases = lastCommitPhases; }
        }
        if (outcome.kind === 'unchanged') {
            return 'unchanged';
        }
        if (outcome.kind === 'rewound') {
            currentMicroBranchTag = outcome.tag;
            ExtensionLogger.log(
                `[同一変更/${outcome.reason}] 新規コミットなし。HEAD→${outcome.commit.substring(0, 7)} (active=${currentMicroBranchTag})`
            );
            vscode.window.setStatusBarMessage(
                `[MicroGit] 同一変更のため HEAD のみ復帰 ${outcome.commit.substring(0, 7)}`,
                3000
            );
            const branchRewind = getCurrentBranch(mainRepoPath);
            if (isRecordableBranch(branchRewind)) {
                schedulePublishToParent(mainRepoPath, branchRewind!);
            }
            lastSaveOutcome = { head: outcome.commit, layerByKernel: false };
            return 'rewound';
        }
        const commitHash = outcome.commit;
        const currentHead = outcome.parent ?? '';
        currentMicroBranchTag = outcome.tag;

        // まだ起動していなければ裏で起動を始め、今回は Node 版の層を書き出す。
        // カーネル版で層を作れたら、Node 版の層とビューは作らない（あとで Node 版に切り替わったら ensureLayerExists が作る）
        let recordedByKernel = false;
        if (useOverlayCheckout() && backendSelector?.wantsKernel) {
            const kernel = backendSelector.readyKernel();
            if (!kernel) {
                void backendSelector.ensureKernel();
            } else {
                try {
                    // 速い記録が「親からの変化」を知っていれば、それで層を作る（Git を起動しない。#37）
                    const r = await kernel.recordCommit(shadowRepoPath, commitHash, outcome.kind === 'created' ? outcome.delta : undefined);
                    recordedByKernel = true;
                    ExtensionLogger.log(
                        `[Overlay/kernel] 層を記録: ${commitHash.substring(0, 7)} ${r.snapshot ? '写しの層' : '差分の層'}${r.fromDelta ? '（記録の変化から）' : ''} ` +
                        `depth=${r.depth} bytes=${r.bytes} ${r.elapsedMs}ms (${relativeFilePath})`
                    );
                } catch (kernelErr: unknown) {
                    backendSelector.reportError(kernelErr);
                }
            }
        }
        if (useOverlayCheckout() && !recordedByKernel) {
            try {
                const overlayPaths = ensureOverlayDirs(mainRepoPath);
                exportCommitLayer(
                    shadowRepoPath,
                    overlayPaths,
                    commitHash,
                    currentHead || undefined,
                    currentMicroBranchTag,
                    runGit,
                    tryRunGit,
                );
                removeFromWriteLayer(overlayPaths, currentMicroBranchTag, relativeFilePath);
                ExtensionLogger.log(
                    `[Overlay] レイヤ+ビュー展開: layers/${commitHash.substring(0, 7)} ` +
                    `view=${commitHash.substring(0, 7)} (${relativeFilePath})`
                );
            } catch (overlayErr: unknown) {
                const msg = overlayErr instanceof Error ? overlayErr.message : String(overlayErr);
                ExtensionLogger.log(`[Overlay] レイヤ書き出しに失敗: ${msg}`, 'WARN');
            }
        }

        timer?.mark('layer');
        timer?.restorable();
        if (timer) { timer.timing.layer = recordedByKernel ? 'kernel' : useOverlayCheckout() ? 'nodejs' : 'none'; }
        lastSaveOutcome = { head: commitHash, layerByKernel: recordedByKernel };

        const branch = getCurrentBranch(mainRepoPath);
        if (isRecordableBranch(branch)) {
            schedulePublishToParent(mainRepoPath, branch!);
        }
        timer?.skip();

        ExtensionLogger.log(`シャドウコミット作成: ${commitHash.substring(0, 7)} (${relativeFilePath}) tag=${currentMicroBranchTag}`);
        vscode.window.setStatusBarMessage(`[MicroGit] 記録 ${commitHash.substring(0, 7)} · ${currentMicroBranchTag}`, 3000);
        return 'created';
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ExtensionLogger.log(`シャドウコミットに失敗しました: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`[MicroGit] 記録に失敗しました: ${message}`);
        return 'error';
    }
}

function detectCurrentTag(shadowRepoPath: string): string {
    // git tag --points-at HEAD -l 'mb-*' の最初（名前の順）と同じ答えを、HEAD とタグのファイルを直接読んで出す
    // （保存のたびに Git を起動しない。#37）。読めなければ Git に任せる
    try {
        const gitDir = resolveGitDir(shadowRepoPath);
        if (readRef(gitDir, 'HEAD')) {
            return firstTagAtHead(gitDir) ?? 'mb-1';
        }
    } catch { /* 下の Git に任せる */ }
    try {
        const attached = runGit(shadowRepoPath, ['tag', '--points-at', 'HEAD', '-l', 'mb-*']).trim();
        if (attached) {
            return attached.split('\n')[0];
        }
    } catch { /* fall through */ }
    return 'mb-1';
}

class ExtensionLogger {
    private static outputChannel: vscode.OutputChannel;
    private static logRecords: Array<{ timestamp: string; level: string; message: string }> = [];
    private static readonly maxRecords = 2000;

    public static initialize(channelName: string) {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    public static log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
        const timestamp = new Date().toISOString();
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
        }
        this.logRecords.push({ timestamp, level, message });
        if (this.logRecords.length > this.maxRecords) {
            this.logRecords.splice(0, this.logRecords.length - this.maxRecords);
        }
    }

    public static async exportLogFile(workspaceRoot: string) {
        // 対象ブランチ以外では成果物を作らない（他ブランチへの混入防止）
        if (!isOnTargetBranch(workspaceRoot)) { return; }
        try {
            const logFolder = path.join(workspaceRoot, '.microgit_logs');
            if (!fs.existsSync(logFolder)) {
                fs.mkdirSync(logFolder);
            }
            fs.writeFileSync(path.join(logFolder, 'log_latest.json'), JSON.stringify(this.logRecords, null, 2), 'utf8');
        } catch { /* ignore export errors */ }
    }
}

function getMainCommitLog(mainRepoPath: string, limit: number): Array<{ hash: string; subject: string }> {
    try {
        const stdout = tryRunGit(mainRepoPath, [
            'log',
            '-n',
            String(limit),
            '--pretty=format:%H%x01%s',
        ]);
        if (!stdout?.trim()) {
            return [];
        }
        return stdout.trim().split('\n').filter(Boolean).map((line) => {
            const [hash = '', subject = ''] = line.split('\x01');
            return { hash, subject };
        });
    } catch {
        return [];
    }
}

function getMicroGraphData(shadowRepoPath: string): Array<{
    hash: string;
    parents: string[];
    tags: string[];
    subject: string;
    timestamp: string;
    mainHead?: string;
}> {
    try {
        const hasCommits = tryRunGit(shadowRepoPath, ['rev-parse', '--verify', 'HEAD']);
        if (!hasCommits) { return []; }

        // body に改行がありうるのでレコード区切りは NUL、フィールドは SOH
        const stdout = runGit(shadowRepoPath, [
            'log',
            '--all',
            '--topo-order',
            '-z',
            '--pretty=format:%H%x01%P%x01%d%x01%s%x01%b%x01%ct',
        ]);
        const records = stdout.split('\0').filter(Boolean);
        return records.map((record) => {
            const parts = record.split('\x01');
            const hash = parts[0] || '';
            const parents = parts[1] ? parts[1].split(' ').filter(Boolean) : [];
            const decorations = parts[2] || '';
            const subject = parts[3] || '';
            const body = parts[4] || '';
            const timestampStr = parts[5] || '0';
            let tags: string[] = [];
            const tagMatch = decorations.match(/tag:\s*([a-zA-Z0-9_-]+)/g);
            if (tagMatch) {
                tags = tagMatch.map((t: string) => t.replace('tag: ', ''));
            }
            const mainHead = parseMainHeadFromMessage(subject, body);
            return {
                hash,
                parents,
                tags,
                subject,
                timestamp: new Date(parseInt(timestampStr, 10) * 1000).toLocaleString(),
                mainHead,
            };
        });
    } catch {
        return [];
    }
}

export function deactivate(): Thenable<void> | undefined {
    // ジャーナルの分を確定させて消す（ADR-0014）。ここで止まっても、次の起動でジャーナルから作り直す
    for (const fc of fastCommitters.values()) {
        try { fc.checkpointSync(); } catch { /* 次の起動で作り直す */ }
    }
    // カーネル版の仮想マシン（または VM なしの agent）を止める。Node.js 版は mount しないので片付け不要
    const selector = backendSelector;
    backendSelector = undefined;
    return selector?.dispose();
}
