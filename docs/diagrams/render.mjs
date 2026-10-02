#!/usr/bin/env node
/**
 * 記事の図（docs/diagrams/*.html）を PNG にする。Chrome（または Edge）を画面なしで動かして撮る。
 * 使い方: node docs/diagrams/render.mjs
 * 1. --dump-dom でページの高さを測る（ページのスクリプトが body の data-h に書く）
 * 2. その高さで撮る（2 倍の解像度）
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const browsers = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
];
const browser = browsers.find((b) => fs.existsSync(b));
if (!browser) { throw new Error('Chrome / Edge が見つからない'); }

const pages = [
    ['save-flow.html', 'microgit-v5-save-flow.png'],
    ['restore-flow.html', 'microgit-v5-restore-flow.png'],
];
const WIDTH = 1000;
fs.mkdirSync(path.join(root, 'images'), { recursive: true });
for (const [src, out] of pages) {
    const url = pathToFileURL(path.join(here, src)).href;
    const common = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${WIDTH},4000`];
    const dom = execFileSync(browser, [...common, '--virtual-time-budget=2000', '--dump-dom', url], { encoding: 'utf8' });
    const h = Number(/data-h="(\d+)"/.exec(dom)?.[1]);
    if (!h) { throw new Error(`${src}: 高さを測れなかった`); }
    const png = path.join(root, 'images', out);
    execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
        `--window-size=${WIDTH},${h}`, '--virtual-time-budget=2000', `--screenshot=${png}`, url], { stdio: 'ignore' });
    console.log(`${out}: ${WIDTH}x${h}（2 倍で撮影）, ${fs.statSync(png).size} バイト`);
}
