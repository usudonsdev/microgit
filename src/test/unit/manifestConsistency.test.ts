/**
 * package.json の contributes と、ソースが登録・参照する文字列が完全に一致することを確かめる単体テスト。VS Code を使わない。
 * 改名（microgit.* → vereve.*）や、コマンド・設定・ビューの追加で、片方だけ直して実行時に「command not found」や
 * 「設定が効かない」「ビューが空」になる事故を、VS Code を起動しないで見つけるためのもの。
 * 観点：
 *  1. 拡張 ID・表示名・コマンドのタイトルの名称
 *  2. contributes.commands と registerCommand（内部コマンド vereve.internal.* を除く）が過不足なく一致 / executeCommand の宛先が実在
 *  3. contributes.configuration の全キーが vereve.* で、ソースで使われ、ソースが読むキーは全部宣言されている
 *  4. ビューコンテナ・ビュー ID・アイコンのファイル・ui.ts の viewType
 *  5. menus / keybindings / activationEvents の参照先が実在（今は無いものは、足されたときに効く）
 *  6. 旧 ID（microgit.<名前> の文字列）がソースや package.json に残っていない（据え置く .microgit や refs/microgit は引用符の直後ではないので対象外）
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';

const ROOT = path.join(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const contributes = pkg.contributes;

/** src の下の .ts（テストを除く）を { 相対パス: 中身 } で返す */
function sourceFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'test') { walk(full); } continue; }
            if (e.name.endsWith('.ts')) { out[path.relative(ROOT, full)] = fs.readFileSync(full, 'utf8'); }
        }
    };
    walk(path.join(ROOT, 'src'));
    return out;
}
const sources = sourceFiles();
const allSource = Object.values(sources).join('\n');

/** 正規表現の 1 番目のグループを全部集める */
function collect(text: string, re: RegExp): string[] {
    return [...text.matchAll(re)].map((m) => m[1]);
}

const contributedCommands: string[] = contributes.commands.map((c: { command: string }) => c.command);
const settingKeys: string[] = Object.keys(contributes.configuration.properties);

describe('package.json とソースの一致（改名後の名称）', () => {
    test('拡張 ID は usudonsdev.vereve、表示名は verEve', () => {
        assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'usudonsdev.vereve');
        assert.strictEqual(pkg.displayName, 'verEve');
        assert.strictEqual(contributes.configuration.title, 'verEve');
    });

    test('コマンドのタイトルは「verEve: 」で始まる', () => {
        for (const c of contributes.commands) { assert.ok(c.title.startsWith('verEve: '), c.title); }
    });
});

describe('コマンド', () => {
    test('contributes.commands は 10 個で、すべて vereve.*', () => {
        assert.strictEqual(contributedCommands.length, 10);
        for (const id of contributedCommands) { assert.match(id, /^vereve\.[A-Za-z]+$/); }
    });

    test('registerCommand した公開コマンドと contributes.commands が過不足なく一致する', () => {
        const registered = collect(allSource, /registerCommand\(\s*'([^']+)'/g);
        const publicRegistered = registered.filter((id) => !id.startsWith('vereve.internal.'));
        assert.deepStrictEqual([...publicRegistered].sort(), [...contributedCommands].sort());
        assert.strictEqual(new Set(registered).size, registered.length, '同じコマンドを二重に登録している');
    });

    test('内部コマンドは vereve.internal.* で、package.json には出さない', () => {
        const registered = collect(allSource, /registerCommand\(\s*'([^']+)'/g);
        const internal = registered.filter((id) => id.startsWith('vereve.internal.'));
        assert.ok(internal.length >= 4, '内部コマンドが見つからない');
        for (const id of internal) { assert.ok(!contributedCommands.includes(id), id); }
    });

    test('executeCommand の宛先は、登録されたコマンドに実在する', () => {
        const registered = new Set(collect(allSource, /registerCommand\(\s*'([^']+)'/g));
        const targets = collect(allSource, /executeCommand(?:<[^>]*>)?\(\s*'(vereve\.[^']+)'/g);
        assert.ok(targets.length > 0);
        for (const id of targets) { assert.ok(registered.has(id), `登録されていないコマンドを呼んでいる: ${id}`); }
    });

    test('ステータスバーなどが command に指定する文字列も実在する', () => {
        const registered = new Set(collect(allSource, /registerCommand\(\s*'([^']+)'/g));
        for (const id of collect(allSource, /\.command\s*=\s*'([^']+)'/g)) { assert.ok(registered.has(id), id); }
    });
});

describe('設定キー', () => {
    test('contributes.configuration のキーは 8 個で、すべて vereve.*', () => {
        assert.strictEqual(settingKeys.length, 8);
        for (const k of settingKeys) { assert.ok(k.startsWith('vereve.'), k); }
    });

    test('宣言したキーは、ソースのどこかで読まれている', () => {
        for (const k of settingKeys) { assert.ok(allSource.includes(`'${k}'`), `ソースで使われていない設定: ${k}`); }
    });

    test('ソースが読む vereve.* の設定キーは、すべて package.json に宣言されている（affectsConfiguration は接頭辞でもよい）', () => {
        const used = collect(allSource, /(?:\.get(?:<[^>]+>)?|\.inspect|getConfig|affectsConfiguration)\(\s*'(vereve\.[^']+)'/g);
        assert.ok(used.length >= 8);
        for (const k of used) {
            assert.ok(settingKeys.some((d) => d === k || d.startsWith(`${k}.`)), `宣言されていない設定を読んでいる: ${k}`);
        }
    });

    test('cfg.get に旧名 microgit. を渡す箇所が無い', () => {
        const short = collect(allSource, /\bcfg\.get(?:<[^>]+>)?\(\s*'(?!vereve\.)([^']+)'/g);
        for (const k of short) { assert.ok(!k.startsWith('microgit.'), k); }
    });
});

describe('ビュー', () => {
    test('ビューコンテナは vereve、その中のビューは vereve.sidebar で、ui.ts の viewType と一致する', () => {
        const containers = contributes.viewsContainers.activitybar;
        assert.deepStrictEqual(containers.map((c: { id: string }) => c.id), ['vereve']);
        assert.deepStrictEqual(Object.keys(contributes.views), ['vereve']);
        const ids = contributes.views.vereve.map((v: { id: string }) => v.id);
        assert.deepStrictEqual(ids, ['vereve.sidebar']);
        const viewType = collect(sources[path.join('src', 'ui.ts')], /viewType\s*=\s*'([^']+)'/g);
        assert.deepStrictEqual(viewType, ids);
    });

    test('アイコンのファイルが実在する（media/vereve.svg）', () => {
        for (const c of contributes.viewsContainers.activitybar) {
            assert.strictEqual(c.icon, 'media/vereve.svg');
            assert.ok(fs.existsSync(path.join(ROOT, c.icon)), c.icon);
        }
        assert.ok(!fs.existsSync(path.join(ROOT, 'media', 'microgit.svg')), '旧アイコンが残っている');
    });
});

describe('menus・keybindings・activationEvents の参照先', () => {
    test('参照するコマンドは contributes.commands に実在する', () => {
        const refs: string[] = [];
        for (const items of Object.values<unknown[]>(contributes.menus ?? {})) {
            for (const it of items as { command?: string }[]) { if (it.command) { refs.push(it.command); } }
        }
        for (const kb of (contributes.keybindings ?? []) as { command: string }[]) { refs.push(kb.command); }
        for (const ev of (pkg.activationEvents ?? []) as string[]) {
            if (ev.startsWith('onCommand:')) { refs.push(ev.slice('onCommand:'.length)); }
        }
        for (const id of refs) { assert.ok(contributedCommands.includes(id), `未定義のコマンドを参照: ${id}`); }
    });

    test('activationEvents は onStartupFinished と、実在する onCommand / onView だけ', () => {
        const viewIds = Object.values<{ id: string }[]>(contributes.views).flat().map((v) => v.id);
        for (const ev of pkg.activationEvents as string[]) {
            if (ev === 'onStartupFinished') { continue; }
            if (ev.startsWith('onCommand:')) { assert.ok(contributedCommands.includes(ev.slice(10)), ev); continue; }
            if (ev.startsWith('onView:')) { assert.ok(viewIds.includes(ev.slice(7)), ev); continue; }
            assert.fail(`知らない activationEvent: ${ev}`);
        }
    });
});

describe('旧 ID が残っていない', () => {
    test('ソースと package.json に、引用符の直後の microgit.<名前>（コマンド・設定・ビュー・状態キー）が無い', () => {
        const old = /['"`]microgit\.[A-Za-z]/;
        for (const [file, text] of Object.entries(sources)) {
            // 引き継ぎの旧接頭辞の定義（settingsMigration.ts）と、旧拡張の ID（legacyExtension.ts）は旧名を持つのが仕事
            if (/settingsMigration\.ts$|legacyExtension\.ts$/.test(file)) { continue; }
            assert.ok(!old.test(text), `${file} に旧 ID が残っている`);
        }
        assert.ok(!old.test(JSON.stringify(pkg.contributes)), 'package.json の contributes に旧 ID が残っている');
        assert.ok(!/"microgit"/.test(JSON.stringify(pkg.contributes)), 'ビューコンテナに旧 ID が残っている');
    });

    test('workspaceState / globalState のキーは vereve.*', () => {
        const keys = collect(allSource, /const STATE_[A-Z_]+\s*=\s*'([^']+)'/g);
        assert.ok(keys.length >= 4);
        for (const k of keys) { assert.ok(k.startsWith('vereve.'), k); }
    });
});
