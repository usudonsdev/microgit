#!/usr/bin/env node
/**
 * VS Code を起動しない単体テスト（src/test/unit/*.test.ts → out/test/unit/*.test.js）を node:test で流す。
 * 使い方: npm run test:unit
 *
 * `node --test` に渡す引数の意味は Node のバージョンで違う（20 はパス、22 以降は glob）。
 * どちらでも動くように、ここでファイルを探して 1 つずつパスで渡す。
 * VS Code の拡張機能テスト（out/test/suite）はここでは流さない（npm test）。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'out', 'test', 'unit');

function find(d) {
    if (!fs.existsSync(d)) { return []; }
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { return find(p); }
        return e.name.endsWith('.test.js') ? [p] : [];
    });
}

const files = find(dir).sort();
if (!files.length) {
    console.error(`単体テストが見つからない: ${dir}（先に npm run compile）`);
    process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
