import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * テスト用の VS Code を起動して、拡張機能テスト（out/test/suite）を流す。
 *
 * ワークスペースは、毎回作る一時的な Git リポジトリ（ブランチ main、最初のコミット 1 つ）。
 * 以前はこのリポジトリそのものを開いていたので、テストのたびに開発中のリポジトリに .microgit_shadow や
 * .git/microgit が残った。MicroGit を有効にして保存・過去に戻る操作まで試すテスト（overlayBackend.test.ts）を
 * 足したので、使い捨てのワークスペースにした（#14）。
 *
 * 環境変数 MICROGIT_TEST_VSIX に VSIX のパスを渡すと、リポジトリではなく、その VSIX を VS Code 自身の
 * インストーラーで一時的な拡張機能フォルダに入れ、入ったフォルダに対してテストを流す（#19）。
 * Marketplace から入れたときと同じ形（.vscodeignore で外したファイルは無い、同梱の部品は resources/kernel、
 * ファイルのモードは VS Code が zip から付けたもの）で動くかを確かめるため。
 */

/**
 * テスト用の VS Code の CLI を、シェルを通さずに呼べる形にする。
 * Windows の bin/code.cmd はバッチファイルで、Node はシェル無しでは起動できない（CVE-2024-27980 の対策）。
 * code.cmd がしていること（ELECTRON_RUN_AS_NODE=1 で Code.exe に cli.js を渡す）を直接する
 */
function vscodeCli(vscodeExecutablePath: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (process.platform !== 'win32') {
        return { command: resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath), args: [], env: process.env };
    }
    const dir = path.dirname(vscodeExecutablePath);
    // 1.139 の Windows 版は <コミット>/resources/app/out/cli.js、古い版は resources/app/out/cli.js
    const candidates = [path.join(dir, 'resources', 'app', 'out', 'cli.js')];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) { candidates.push(path.join(dir, ent.name, 'resources', 'app', 'out', 'cli.js')); }
    }
    const cli = candidates.find((c) => fs.existsSync(c));
    if (!cli) { throw new Error(`cli.js が見つからない: ${dir}`); }
    return { command: vscodeExecutablePath, args: [cli], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
}

/**
 * テスト用の VS Code の実行ファイル。@vscode/test-electron 2.5.2 は、Mac では
 * 「Visual Studio Code.app/Contents/MacOS/Electron」を返すが、VS Code 1.139.1 の Mac 版にはそれが無く、
 * 起動が ENOENT で失敗した（#19、package.yml の macos-14）。無ければ同じフォルダの実行ファイルを探す
 */
function resolveVSCodeExecutable(returned: string): string {
    if (fs.existsSync(returned) || process.platform !== 'darwin') { return returned; }
    const dir = path.dirname(returned);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const found = ['Code', 'Code - Insiders', 'Visual Studio Code'].find((n) => names.includes(n));
    if (!found) { throw new Error(`VS Code の実行ファイルが見つからない: ${dir}（中身: ${names.join(', ') || '無し'}）`); }
    console.log(`VS Code の実行ファイル: ${path.join(dir, found)}（test-electron が返したのは ${path.basename(returned)}）`);
    return path.join(dir, found);
}

/** VSIX を一時的な拡張機能フォルダに入れて、入ったフォルダを返す */
function installVsix(vscodeExecutablePath: string, vsix: string, extensionsDir: string): string {
    const cli = vscodeCli(vscodeExecutablePath);
    const out = execFileSync(cli.command, [
        ...cli.args,
        '--extensions-dir', extensionsDir,
        '--user-data-dir', path.join(extensionsDir, '..', 'user-data'),
        '--install-extension', vsix,
        '--force',
    ], { env: cli.env, encoding: 'utf8' });
    console.log(out.trim());
    const installed = fs.readdirSync(extensionsDir).filter((n) => n.startsWith('usudonsdev.microgit-'));
    if (installed.length !== 1) { throw new Error(`入った拡張機能が 1 つでない: ${installed.join(', ') || '(無し)'}`); }
    const folder = path.join(extensionsDir, installed[0]);
    console.log(`installed: ${folder}`);
    // 同梱の部品と、そのモード（POSIX）を記録する
    const kernelDir = path.join(folder, 'resources', 'kernel');
    const walk = (d: string): string[] => fs.existsSync(d)
        ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
        : [];
    const files = walk(kernelDir).filter((f) => !f.endsWith('.dll') && !f.includes(`${path.sep}share${path.sep}`));
    for (const f of files) {
        const st = fs.statSync(f);
        console.log(`  ${path.relative(folder, f)}  ${st.size} bytes  mode ${(st.mode & 0o777).toString(8)}`);
    }
    if (files.length === 0) { console.log('  （resources/kernel は無い：Node.js 版だけ）'); }
    return folder;
}

async function main() {
    // VS Code（や Electron のアプリ）の中からこのスクリプトを動かすと ELECTRON_RUN_AS_NODE=1 が引き継がれ、
    // テスト用の VS Code が普通の Node として起動して、ワークスペースのパスを JavaScript として読もうとする
    delete process.env.ELECTRON_RUN_AS_NODE;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-vscode-test-'));
    try {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
        git('init', '-q', '-b', 'main');
        git('config', 'core.autocrlf', 'false');
        fs.writeFileSync(path.join(workspace, 'README.md'), '# MicroGit extension test workspace\n');
        git('add', '-A');
        git('-c', 'user.name=MicroGit Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');

        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const vsix = process.env.MICROGIT_TEST_VSIX;
        const vscodeExecutablePath = resolveVSCodeExecutable(await downloadAndUnzipVSCode());
        let extensionDevelopmentPath = path.resolve(__dirname, '../../');
        if (vsix) {
            const extensionsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-vsix-')), 'extensions');
            fs.mkdirSync(extensionsDir, { recursive: true });
            extensionDevelopmentPath = installVsix(vscodeExecutablePath, path.resolve(vsix), extensionsDir);
        }

        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspace,
                '--disable-extensions', // 他の不要な拡張機能を無効化してテストを安定させる
                // 組み込みの Git 拡張機能も止める。ワークスペースの中の Git リポジトリ（.microgit_shadow など）を
                // 見つけて開き、Windows でフォルダを掴んで消せなくする（EPERM）ことがある
                '--disable-extension', 'vscode.git',
            ],
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exitCode = 1;
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

main();
