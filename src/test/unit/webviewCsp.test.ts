/**
 * Webview の CSP（src/webviewCsp.ts）と、Publish の確認文（src/publishConfirm.ts）の単体テスト。
 * VS Code を起動しない。ui.ts は vscode を import するので読み込めないため、テンプレートは
 * ソースを文字列として読み、CSP を壊す書き方（style 属性・外部読み込み・on*= 属性）が混ざっていないかを確かめる。
 * 実行は npm run test:unit。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';
import { applyCsp, buildCsp, makeNonce } from '../../webviewCsp';
import { buildPublishConfirmMessage, maskRemoteUrl } from '../../publishConfirm';

describe('Webview の CSP', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>a{}</style></head><body><script>1</script></body></html>';

    test('meta と、すべての script・style への nonce が付く', () => {
        const out = applyCsp(html, 'abc123==');
        assert.ok(out.includes(`<meta http-equiv="Content-Security-Policy" content="${buildCsp('abc123==')}" />`));
        assert.ok(out.includes('<style nonce="abc123==">'));
        assert.ok(out.includes('<script nonce="abc123==">'));
        assert.ok(!/<(script|style)>/.test(out), 'nonce の無い開始タグが残っている');
    });

    test('ポリシー：default-src none、script・style は nonce だけ、unsafe-inline は無い', () => {
        assert.strictEqual(
            buildCsp('N'),
            "default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N'; base-uri 'none'; form-action 'none'"
        );
        assert.ok(!buildCsp('N').includes('unsafe'));
    });

    test('nonce は呼ぶたびに違い、CSP に使える文字だけ', () => {
        const a = makeNonce();
        assert.notStrictEqual(a, makeNonce());
        assert.match(a, /^[A-Za-z0-9+/]+=*$/);
    });

    test('<head> が無い HTML は例外', () => {
        assert.throws(() => applyCsp('<html></html>'));
    });

    test('ui.ts のテンプレートは CSP で止まる書き方をしていない', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ui.ts'), 'utf8');
        assert.ok(!/\sstyle\s*=/.test(src), 'style 属性は CSP（style-src nonce）で止まる。class にすること');
        assert.ok(!/setAttribute\(\s*['"]style/.test(src));
        assert.ok(!/<script[^>]*\ssrc=|<link\s|<img\s|<iframe/.test(src), '外部の読み込みは default-src none で止まる');
        assert.ok(!/\son(click|change|mouse\w+|load|error)\s*=\s*["']/.test(src), 'on*= 属性は script-src で止まる');
        // テンプレートは 2 つ（サイドバーとグラフ）で、どちらも <head> を持つ
        assert.strictEqual((src.match(/<head>/g) ?? []).length, 2);
        assert.strictEqual((src.match(/applyCsp\(get/g) ?? []).length, 2);
    });
});

describe('Publish の確認', () => {
    test('URL の認証情報を取り除く。ssh 形式の git@ は残す', () => {
        assert.strictEqual(maskRemoteUrl('https://user:tok@github.com/a/b.git\n'), 'https://github.com/a/b.git');
        assert.strictEqual(maskRemoteUrl('https://tok@github.com/a/b.git'), 'https://github.com/a/b.git');
        assert.strictEqual(maskRemoteUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
        assert.strictEqual(maskRemoteUrl('ssh://git@host/a/b.git'), 'ssh://host/a/b.git');
        // 漏れていた形（独立レビューの指摘）
        assert.strictEqual(maskRemoteUrl('https://user:p@ss@host/a'), 'https://host/a');
        assert.strictEqual(maskRemoteUrl('https://user:p/ss@host/a'), 'https://host/a');
        assert.strictEqual(maskRemoteUrl('user:tok@host:path/r.git'), 'host:path/r.git');
        assert.strictEqual(maskRemoteUrl('https://host/a/b.git?token=SECRET&x=1#frag'), 'https://host/a/b.git');
        assert.strictEqual(maskRemoteUrl('https://host/ghp_AbC123xyz/b.git'), 'https://host/***/b.git');
        assert.strictEqual(maskRemoteUrl('https://host/github_pat_11AB_cd/b.git'), 'https://host/***/b.git');
        for (const u of ['https://user:p@ss@host/a', 'https://user:p/ss@host/a', 'user:tok@host:p']) {
            assert.ok(!/p@ss|ss@|tok/.test(maskRemoteUrl(u)), u);
        }
    });

    test('本文に origin・全ブランチ・refs/microgit/* が出る', () => {
        const m = buildPublishConfirmMessage('https://github.com/a/b.git', 'main');
        assert.ok(m.includes('origin（https://github.com/a/b.git）'));
        assert.ok(m.includes('refs/microgit/*'));
        assert.ok(m.includes('全ブランチ'));
        assert.ok(m.includes('main'));
    });
});
