import * as assert from 'assert';
import * as path from 'path';
import { describe, test } from 'node:test';
import { findInPath, kernelAtLeast, LauncherDeps, parseKernelVersion, planLaunch, qemuArgs } from '../../kernel/launchers';

const EXT = path.join(path.sep, 'ext');

function deps(over: Partial<LauncherDeps> & { files?: string[] }): LauncherDeps {
    const files = new Set(over.files ?? []);
    return {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0-1064-azure',
        extensionPath: EXT,
        env: { PATH: '/usr/bin' },
        settings: {},
        logDir: path.join(path.sep, 'logs'),
        exists: (p) => files.has(p),
        which: (cmd) => (cmd === 'unshare' ? '/usr/bin/unshare' : undefined),
        ...over,
    };
}

const bundled = (...parts: string[]) => path.join(EXT, 'resources', 'kernel', ...parts);
const dev = (...parts: string[]) => path.join(EXT, ...parts);

describe('カーネルの版', () => {
    test('os.release() の形から major.minor を読む', () => {
        assert.deepStrictEqual(parseKernelVersion('6.6.87.2-microsoft-standard-WSL2'), [6, 6]);
        assert.deepStrictEqual(parseKernelVersion('5.11.0'), [5, 11]);
        assert.deepStrictEqual(parseKernelVersion('garbage'), [0, 0]);
        assert.ok(kernelAtLeast('5.11.0', 5, 11));
        assert.ok(kernelAtLeast('6.0.1', 5, 11));
        assert.ok(!kernelAtLeast('5.10.200', 5, 11));
        assert.ok(!kernelAtLeast('6.5.9', 6, 6));
    });
});

describe('Linux: VM なし（unshare -Urm）', () => {
    test('同梱の agent を unshare で起動する。6.6 以降で XDG_RUNTIME_DIR があれば層を tmpfs に置く', () => {
        const plan = planLaunch(deps({
            files: [bundled('linux-x64', 'microgit-agent')],
            env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
        }));
        assert.ok(plan.ok);
        assert.strictEqual(plan.kind, 'linux-native');
        assert.strictEqual(plan.spec.command, '/usr/bin/unshare');
        assert.deepStrictEqual(plan.spec.args, ['-Urm', bundled('linux-x64', 'microgit-agent')]);
        assert.strictEqual(plan.spec.env?.MICROGIT_AGENT_STATE_DIR, path.join('/run/user/1000', 'microgit'));
    });

    test('6.6 より前のカーネルでは tmpfs に置かない（tmpfs の user.* xattr が無い）', () => {
        const plan = planLaunch(deps({ osRelease: '6.1.0', files: [bundled('linux-x64', 'microgit-agent')], env: { XDG_RUNTIME_DIR: '/run/user/1000' } }));
        assert.ok(plan.ok);
        assert.strictEqual(plan.spec.env?.MICROGIT_AGENT_STATE_DIR, undefined);
    });

    test('開発中はリポジトリのビルド結果（guest/out/<arch>/init）を使う', () => {
        const plan = planLaunch(deps({ arch: 'arm64', files: [dev('guest', 'out', 'arm64', 'init')] }));
        assert.ok(plan.ok);
        assert.deepStrictEqual(plan.spec.args, ['-Urm', dev('guest', 'out', 'arm64', 'init')]);
    });

    test('起動する前に agent の実行ビットを確かめる（VSIX で落ちることがある、#19）', () => {
        const agent = bundled('linux-x64', 'microgit-agent');
        const asked: string[] = [];
        const ok = planLaunch(deps({ files: [agent], ensureExecutable: (p) => { asked.push(p); return undefined; } }));
        assert.ok(ok.ok);
        assert.deepStrictEqual(asked, [agent]);

        const ng = planLaunch(deps({ files: [agent], ensureExecutable: () => 'EACCES: permission denied' }));
        assert.ok(!ng.ok);
        assert.match(ng.reason, /microgit-agent is not executable: EACCES/);
    });

    test('使えない理由を返す', () => {
        const reasons = [
            planLaunch(deps({ osRelease: '5.10.0', files: [bundled('linux-x64', 'microgit-agent')] })),
            planLaunch(deps({ files: [] })),
            planLaunch(deps({ files: [bundled('linux-x64', 'microgit-agent')], which: () => undefined })),
            planLaunch(deps({ arch: 'ia32' })),
        ].map((p) => (p.ok ? 'ok' : p.reason));
        assert.match(reasons[0], /older than 5\.11/);
        assert.match(reasons[1], /not bundled/);
        assert.match(reasons[2], /unshare/);
        assert.match(reasons[3], /not supported/);
    });
});

describe('Windows: QEMU', () => {
    const image = bundled('guest', 'x86_64', 'Image');
    const qemu = bundled('win32-x64', 'qemu', 'qemu-system-x86_64.exe');

    test('同梱の QEMU とゲストで起動する。既定は WHPX → TCG。通り道は毎回乱数の名前の名前付きパイプ', () => {
        const plan = planLaunch(deps({ platform: 'win32', files: [image, qemu], randomId: () => 'r4nd0m' }));
        assert.ok(plan.ok);
        assert.strictEqual(plan.kind, 'qemu');
        assert.strictEqual(plan.spec.command, qemu);
        const a = plan.spec.args.join(' ');
        assert.match(a, /-accel whpx,kernel-irqchip=off -accel tcg/);
        assert.match(a, new RegExp(`-kernel ${image.replace(/\\/g, '\\\\')}`));
        assert.match(a, /name=microgit/);
        assert.match(a, /-m 256/);
        assert.ok(plan.spec.args.includes('pipe,id=proto,path=microgit-r4nd0m'));
        assert.ok(!a.includes('stdio,id=proto'));
        assert.strictEqual(plan.spec.namedPipe, String.raw`\\.\pipe\microgit-r4nd0m`);
        // 既定の乱数は毎回違う（128 ビット）
        const p1 = planLaunch(deps({ platform: 'win32', files: [image, qemu] }));
        const p2 = planLaunch(deps({ platform: 'win32', files: [image, qemu] }));
        assert.ok(p1.ok && p2.ok && p1.spec.namedPipe !== p2.spec.namedPipe);
        assert.match(p1.ok ? p1.spec.namedPipe ?? '' : '', /microgit-[0-9a-f]{32}$/);
    });

    test('設定の QEMU の場所と動かし方とメモリを使う', () => {
        const plan = planLaunch(deps({ platform: 'win32', files: [image, 'C:\\q\\qemu.exe'], settings: { qemuPath: 'C:\\q\\qemu.exe', accel: 'tcg', memoryMb: 512 } }));
        assert.ok(plan.ok);
        assert.strictEqual(plan.spec.command, 'C:\\q\\qemu.exe');
        assert.ok(!plan.spec.args.includes('whpx,kernel-irqchip=off'));
        assert.deepStrictEqual(plan.spec.args.slice(2, 4), ['-accel', 'tcg']);
        assert.ok(plan.spec.args.includes('512'));
    });

    test('使えない理由を返す', () => {
        const r1 = planLaunch(deps({ platform: 'win32', files: [qemu] }));
        const r2 = planLaunch(deps({ platform: 'win32', files: [image] }));
        const r3 = planLaunch(deps({ platform: 'win32', files: [image], settings: { qemuPath: 'C:\\missing.exe' } }));
        const r4 = planLaunch(deps({ platform: 'win32', arch: 'arm64', files: [image, qemu] }));
        assert.ok(!r1.ok && /guest image/.test(r1.reason));
        assert.ok(!r2.ok && /QEMU is not bundled/.test(r2.reason));
        assert.ok(!r3.ok && /missing\.exe/.test(r3.reason));
        assert.ok(!r4.ok && /arm64/.test(r4.reason));
    });

    test('qemuArgs は windows/run-golden.ps1 と同じ構成', () => {
        assert.deepStrictEqual(qemuArgs('I', 'L', { accel: 'whpx' }).slice(0, 4), ['-M', 'q35', '-accel', 'whpx,kernel-irqchip=off']);
    });
});

describe('macOS: Virtualization.framework', () => {
    test('arm64 は microgit-vm で起動し、virtio-console のフレーム上限を指定する', () => {
        const plan = planLaunch(deps({ platform: 'darwin', arch: 'arm64', files: [bundled('guest', 'arm64', 'Image'), bundled('darwin-arm64', 'microgit-vm')] }));
        assert.ok(plan.ok);
        assert.strictEqual(plan.kind, 'vz');
        assert.deepStrictEqual(plan.spec.args.slice(0, 2), ['--kernel', bundled('guest', 'arm64', 'Image')]);
        assert.strictEqual(plan.spec.maxFrameBytes, 48 * 1024);
    });

    test('microgit-vm の実行ビットも確かめる（ゲストの Image は実行しないので確かめない）', () => {
        const asked: string[] = [];
        const plan = planLaunch(deps({
            platform: 'darwin', arch: 'arm64',
            files: [bundled('guest', 'arm64', 'Image'), bundled('darwin-arm64', 'microgit-vm')],
            ensureExecutable: (p) => { asked.push(p); return undefined; },
        }));
        assert.ok(plan.ok);
        assert.deepStrictEqual(asked, [bundled('darwin-arm64', 'microgit-vm')]);
    });

    test('Intel Mac は対象外', () => {
        const plan = planLaunch(deps({ platform: 'darwin', arch: 'x64' }));
        assert.ok(!plan.ok);
    });
});

describe('PATH からコマンドを探す', () => {
    test('POSIX は : 区切り、Windows は ; 区切りで PATHEXT を試す', () => {
        const have = new Set([path.join('/b', 'unshare'), path.join('C:\\w', 'git.EXE')]);
        assert.strictEqual(findInPath('unshare', { PATH: '/a:/b' }, 'linux', (p) => have.has(p)), path.join('/b', 'unshare'));
        assert.strictEqual(findInPath('git', { Path: 'C:\\x;C:\\w', PATHEXT: '.EXE;.CMD' }, 'win32', (p) => have.has(p)), path.join('C:\\w', 'git.EXE'));
        assert.strictEqual(findInPath('nope', { PATH: '/a' }, 'linux', () => false), undefined);
    });
});
