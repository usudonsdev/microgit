/**
 * Webview の HTML に Content-Security-Policy（CSP）を付ける、vscode に依存しない純関数。
 * 単体テスト（src/test/unit/webviewCsp.test.ts）で、生成した HTML を直接確かめるために ui.ts から切り出した。
 *
 * 方針（docs/design-policy.md の Webview の CSP の節）:
 * - default-src 'none'：画像・フォント・通信・フレームなど、今の画面が使っていないものは全部止める
 * - script-src / style-src は nonce 付きの <script>・<style> だけ許す。画面の中身（コミットのメッセージなど）が
 *   innerHTML 経由で混ざっても、nonce を知らない <script> や on*= の属性は動かない
 * - style="..." の属性と setAttribute('style') は止まる（nonce は属性に効かない）。今のテンプレートは
 *   style 属性を使っていない（要素.style.x = ... の CSSOM 操作は CSP の対象外）。足すときは class にすること
 * - base-uri / form-action も 'none'（default-src では覆えない）
 */
import { randomBytes } from 'crypto';

/** CSP 用の nonce。リクエスト（= HTML を作るたび）ごとに新しく作る。base64 は CSP の nonce に使える文字だけ（+ / =）。 */
export function makeNonce(): string {
    return randomBytes(16).toString('base64');
}

/** nonce を使う CSP の文字列。 */
export function buildCsp(nonce: string): string {
    return [
        `default-src 'none'`,
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        `base-uri 'none'`,
        `form-action 'none'`,
    ].join('; ');
}

/**
 * テンプレートの HTML に CSP の <meta> を足し、<script>・<style> の開始タグに nonce を付けて返す。
 * <head> が無い HTML は不正なので例外にする（CSP が付かないまま表示してしまうのを防ぐ）。
 */
export function applyCsp(html: string, nonce: string = makeNonce()): string {
    if (!/<head>/.test(html)) {
        throw new Error('applyCsp: <head> が見つからない');
    }
    const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(nonce)}" />`;
    return html
        .replace('<head>', `<head>\n${meta}`)
        .replace(/<(script|style)>/g, `<$1 nonce="${nonce}">`);
}
