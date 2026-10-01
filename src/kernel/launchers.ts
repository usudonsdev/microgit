/**
 * プラットフォームごとに、agent をどう起動するかを決める（#14、要件 FR-5・AD-2）。
 *
 * | ホスト  | 起動のしかた                                         | 必要なもの                         |
 * |---------|------------------------------------------------------|------------------------------------|
 * | Linux   | `unshare -Urm <agent>`（VM なし。AD-2）               | カーネル 5.11 以降、unshare、agent |
 * | Windows | QEMU で最小ゲストを起動（WHPX → TCG。#18）            | qemu-system-x86_64、x86_64 の Image |
 * | macOS   | microgit-vm（Virtualization.framework。#17、未確認）  | microgit-vm、arm64 の Image        |
 *
 * どれも「起動できそうか」をここでは確かめるだけで、本当に使えるか（mount できるか）は起動して試す
 * （backendSelector.ts）。Ubuntu 23.10 以降のように非特権のユーザー名前空間が止められている環境
 * （補足 S-3）は、起動してから unshare が失敗して分かる。
 *
 * VS Code に依存しない（単体テストで確かめるため）。ファイルの有無やコマンドの場所は deps で受け取る。
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import { LaunchSpec } from './agentConnection';

export type LaunchKind = 'linux-native' | 'qemu' | 'vz';

export type LaunchPlan =
    | { ok: true; kind: LaunchKind; spec: LaunchSpec; notes: string[] }
    | { ok: false; reason: string };

export type KernelSettings = {
    /** QEMU の場所（空なら同梱・開発用の場所を探す） */
    qemuPath?: string;
    /** QEMU の動かし方。auto は WHPX を試してだめなら TCG */
    accel?: 'auto' | 'whpx' | 'tcg';
    /** 最小ゲストのメモリ（MB） */
    memoryMb?: number;
};

export type LauncherDeps = {
    platform: NodeJS.Platform;
    arch: string;
    /** os.release()。Linux のカーネルの版を見る */
    osRelease: string;
    /** 拡張機能のフォルダ（開発中はリポジトリのルート） */
    extensionPath: string;
    env: NodeJS.ProcessEnv;
    settings: KernelSettings;
    /** ゲストのログ（hvc0）を書く場所 */
    logDir: string;
    exists: (p: string) => boolean;
    /** PATH からコマンドを探す */
    which: (cmd: string) => string | undefined;
    /** 名前付きパイプの名前に使う乱数（テストで固定するため）。既定は 128 ビットの乱数 */
    randomId?: () => string;
    /**
     * 同梱の実行ファイル（Linux の agent、macOS の microgit-vm）に実行ビットを付ける。
     * VSIX（zip）を Windows で作ると実行ビットが落ちる（vsce の文書）。付けられなければ理由を返す。
     * 省略すると何もしない（単体テスト、Windows）
     */
    ensureExecutable?: (p: string) => string | undefined;
};

/** PATH からコマンドを探す（Windows では PATHEXT の拡張子も試す） */
export function findInPath(
    cmd: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    exists: (p: string) => boolean,
): string | undefined {
    const pathVar = env.PATH ?? env.Path ?? '';
    const sep = platform === 'win32' ? ';' : ':';
    const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
    for (const dir of pathVar.split(sep).filter(Boolean)) {
        for (const ext of exts) {
            const candidate = path.join(dir, cmd + ext);
            if (exists(candidate)) { return candidate; }
        }
    }
    return undefined;
}

/** `6.6.87.2-microsoft-standard-WSL2` → [6, 6]。読めなければ [0, 0] */
export function parseKernelVersion(release: string): [number, number] {
    const m = /^(\d+)\.(\d+)/.exec(release);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

export function kernelAtLeast(release: string, major: number, minor: number): boolean {
    const [a, b] = parseKernelVersion(release);
    return a > major || (a === major && b >= minor);
}

/** 同梱の置き場所（VSIX の中）と、開発中の置き場所（リポジトリのビルド結果）を順に探す */
function firstExisting(deps: LauncherDeps, candidates: string[]): string | undefined {
    return candidates.find((p) => deps.exists(p));
}

function resource(deps: LauncherDeps, ...parts: string[]): string {
    return path.join(deps.extensionPath, 'resources', 'kernel', ...parts);
}

/** 実行ビットを確かめ、付けられなければ LaunchPlan の失敗にする */
function executableOrReason(deps: LauncherDeps, file: string): string | undefined {
    const err = deps.ensureExecutable?.(file);
    return err ? `${file} is not executable: ${err}` : undefined;
}

/** Node の arch を、ゲストのビルドの名前（guest/out/<名前>）にする */
function guestArch(arch: string): 'x86_64' | 'arm64' | undefined {
    if (arch === 'x64') { return 'x86_64'; }
    if (arch === 'arm64') { return 'arm64'; }
    return undefined;
}

export function planLaunch(deps: LauncherDeps): LaunchPlan {
    switch (deps.platform) {
        case 'linux': return planLinux(deps);
        case 'win32': return planWindows(deps);
        case 'darwin': return planMac(deps);
        default: return { ok: false, reason: `platform ${deps.platform} is not supported` };
    }
}

function planLinux(deps: LauncherDeps): LaunchPlan {
    const ga = guestArch(deps.arch);
    if (!ga) { return { ok: false, reason: `CPU ${deps.arch} is not supported` }; }
    if (!kernelAtLeast(deps.osRelease, 5, 11)) {
        return { ok: false, reason: `kernel ${deps.osRelease} is older than 5.11 (unprivileged OverlayFS needs userxattr)` };
    }
    const agent = firstExisting(deps, [
        resource(deps, `linux-${deps.arch}`, 'microgit-agent'),
        path.join(deps.extensionPath, 'guest', 'out', ga, 'init'),
    ]);
    if (!agent) { return { ok: false, reason: `agent binary for linux-${deps.arch} is not bundled` }; }
    const notExecutable = executableOrReason(deps, agent);
    if (notExecutable) { return { ok: false, reason: notExecutable }; }
    const unshare = deps.which('unshare');
    if (!unshare) { return { ok: false, reason: 'unshare (util-linux) is not found in PATH' }; }

    const notes: string[] = [];
    const env: NodeJS.ProcessEnv = { ...deps.env };
    // 層は tmpfs に置くと速い（ADR-0004）。tmpfs を upper にするには tmpfs の user.* xattr（6.6 以降）が要る
    const runtimeDir = deps.env.XDG_RUNTIME_DIR;
    if (runtimeDir && kernelAtLeast(deps.osRelease, 6, 6)) {
        env.MICROGIT_AGENT_STATE_DIR = path.join(runtimeDir, 'microgit');
        notes.push(`layers on tmpfs (${env.MICROGIT_AGENT_STATE_DIR})`);
    } else {
        notes.push('layers in the temporary directory');
    }
    return {
        ok: true,
        kind: 'linux-native',
        spec: { command: unshare, args: ['-Urm', agent], env, description: `linux-native: unshare -Urm ${agent}` },
        notes,
    };
}

/**
 * QEMU の引数（windows/run-golden.ps1 と同じ構成）。
 * proto は命令の通り道: 'stdio'（QEMU の stdin/stdout。Linux の CI）か、{ pipe: 名前 }（Windows の名前付きパイプ）。
 */
export function qemuArgs(image: string, consoleLog: string, settings: KernelSettings, proto: 'stdio' | { pipe: string } = 'stdio'): string[] {
    const accel = settings.accel ?? 'auto';
    const accelArgs = accel === 'whpx'
        ? ['-accel', 'whpx,kernel-irqchip=off']
        : accel === 'tcg'
            ? ['-accel', 'tcg']
            : ['-accel', 'whpx,kernel-irqchip=off', '-accel', 'tcg'];
    return [
        '-M', 'q35', ...accelArgs,
        '-cpu', 'max', '-smp', '1', '-m', String(settings.memoryMb ?? 256),
        '-nodefaults', '-display', 'none', '-no-reboot',
        '-kernel', image, '-append', 'console=hvc0',
        '-device', 'virtio-serial-pci',
        '-chardev', `file,id=con,path=${consoleLog}`,
        '-device', 'virtconsole,chardev=con',
        '-chardev', proto === 'stdio' ? 'stdio,id=proto,signal=off' : `pipe,id=proto,path=${proto.pipe}`,
        '-device', 'virtserialport,chardev=proto,name=microgit',
    ];
}

function planWindows(deps: LauncherDeps): LaunchPlan {
    if (deps.arch !== 'x64') { return { ok: false, reason: `Windows on ${deps.arch} is not supported yet` }; }
    const image = firstExisting(deps, [
        resource(deps, 'guest', 'x86_64', 'Image'),
        path.join(deps.extensionPath, 'guest', 'out', 'x86_64', 'Image'),
    ]);
    if (!image) { return { ok: false, reason: 'x86_64 guest image is not bundled' }; }
    const qemu = deps.settings.qemuPath
        ? (deps.exists(deps.settings.qemuPath) ? deps.settings.qemuPath : undefined)
        : firstExisting(deps, [
            resource(deps, 'win32-x64', 'qemu', 'qemu-system-x86_64.exe'),
            path.join(deps.extensionPath, 'guest', '.cache', 'qemu-win', 'qemu-system-x86_64.exe'),
        ]);
    if (!qemu) {
        return { ok: false, reason: deps.settings.qemuPath ? `QEMU not found at ${deps.settings.qemuPath}` : 'QEMU is not bundled' };
    }
    const consoleLog = path.join(deps.logDir, 'microgit-guest-console.log');
    // 命令の通り道は名前付きパイプ。Windows 版 QEMU の stdio は遅く、大きなデータで中身が壊れた（agentConnection.ts）。
    // 名前は毎回 128 ビットの乱数。QEMU のパイプは接続を 1 つしか受け付けないので、MicroGit がつないだあとは
    // ほかのプロセスはつなげない。先を越されたら MicroGit はつなげずに Node 版に切り替わる（docs/kernel-backend.md §4）
    const pipeName = `microgit-${(deps.randomId ?? (() => randomBytes(16).toString('hex')))()}`;
    return {
        ok: true,
        kind: 'qemu',
        spec: {
            command: qemu,
            args: qemuArgs(image, consoleLog, deps.settings, { pipe: pipeName }),
            namedPipe: `\\\\.\\pipe\\${pipeName}`,
            description: `qemu (${deps.settings.accel ?? 'auto'}, named pipe): ${qemu}`,
        },
        notes: [`guest console log: ${consoleLog}`],
    };
}

function planMac(deps: LauncherDeps): LaunchPlan {
    if (deps.arch !== 'arm64') { return { ok: false, reason: 'Intel Mac is not supported yet' }; }
    const image = firstExisting(deps, [
        resource(deps, 'guest', 'arm64', 'Image'),
        path.join(deps.extensionPath, 'guest', 'out', 'arm64', 'Image'),
    ]);
    if (!image) { return { ok: false, reason: 'arm64 guest image is not bundled' }; }
    const helper = firstExisting(deps, [
        resource(deps, 'darwin-arm64', 'microgit-vm'),
        path.join(deps.extensionPath, 'mac', '.build', 'microgit-vm'),
    ]);
    if (!helper) { return { ok: false, reason: 'microgit-vm is not bundled' }; }
    const notExecutable = executableOrReason(deps, helper);
    if (notExecutable) { return { ok: false, reason: notExecutable }; }
    const consoleLog = path.join(deps.logDir, 'microgit-guest-console.log');
    // 実機で agent だけ差し替えて試すための開発用 initramfs。配布版の agent は Image に埋め込む。
    const developmentInitrd = firstExisting(deps, [path.join(deps.extensionPath, 'guest', 'out', 'arm64', 'initrd.cpio')]);
    const args = ['--kernel', image];
    if (developmentInitrd) { args.push('--initrd', developmentInitrd); }
    args.push('--console', consoleLog, '--memory-mb', String(deps.settings.memoryMb ?? 256));
    return {
        ok: true,
        kind: 'vz',
        spec: {
            command: helper,
            args,
            // macOS 26.5.1 の実機では、virtio-console の約 64 KiB を超える 1 行が停止した。
            // LayerFeeder / KernelOverlayBackend はこの値があると stage/readChunk に分割する。
            maxFrameBytes: 48 * 1024,
            description: `Virtualization.framework: ${helper}`,
        },
        notes: [`guest console log: ${consoleLog}`],
    };
}
