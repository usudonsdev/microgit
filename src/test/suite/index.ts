/**
 * 拡張機能テストの Mocha の入口（TDD スタイル）。直接は呼ばない。
 * src/test/runTest.ts が extensionTestsPath としてこのファイルを指定し、VS Code のテストランナーが run を呼ぶ。
 * out/test/suite/ の *.test.js をすべて読んで流す。
 */
import * as fs from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

/** out/test/suite の *.test.js を Mocha で流す。失敗が 1 つでもあれば reject し、VS Code のテストランナーは失敗として終わる。 */
export function run(): Promise<void> {
    // Mochaの初期設定 (VS Code標準の TDD スタイル)
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    return new Promise((resolve, reject) => {
        const testsRoot = __dirname;

        try {
            // suite フォルダ内のファイルを走査
            const files = fs.readdirSync(testsRoot);
            // extension.test.js などのテストファイルを抽出
            const testFiles = files.filter(f => f.endsWith('.test.js'));

            if (testFiles.length === 0) {
                return reject(new Error(`テストファイル（*.test.js）が ${testsRoot} 内に見つかりませんでした。`));
            }

            // すべてのテストファイルをMochaの実行対象に追加
            testFiles.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

            // テストを実行
            mocha.run(failures => {
                if (failures > 0) {
                    reject(new Error(`${failures} 個のテストが失敗しました。`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}