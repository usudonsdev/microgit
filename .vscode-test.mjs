/**
 * VS Code の拡張機能テストの設定（@vscode/test-cli の vscode-test コマンドが読む）。
 * コンパイル済みのテスト（out/test 以下の .test.js）を流す。package.json の test スクリプトは out/test/runTest.js を直接使う。
 */
import {defineConfig} from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
});
