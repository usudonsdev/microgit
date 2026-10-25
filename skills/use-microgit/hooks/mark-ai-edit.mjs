#!/usr/bin/env node
// Cursor の afterFileEdit / afterTabFileEdit から呼ばれ、保存時に [AI] が付くようパスを残す。
// stdout は空の JSON。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

let input = {};
try {
    input = JSON.parse(readStdin() || '{}');
} catch {
    input = {};
}

const filePath = input.file_path || input.path || '';
process.stdout.write('{}\n');
if (!filePath) {
    process.exit(0);
}

let root = process.cwd();
try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        cwd: path.dirname(filePath),
    }).trim();
} catch {
    // Git 管理外なら、フックのカレントディレクトリを基準にする。
}

const rel = path.relative(root, path.resolve(filePath)).split(path.sep).join('/');
if (!rel || rel.startsWith('..') || rel.startsWith('.microgit_') || rel.startsWith('.cursor/')) {
    process.exit(0);
}

const pendingFile = path.join(root, '.microgit_logs', 'ai-pending.json');
fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
let list = [];
try {
    const parsed = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    if (Array.isArray(parsed)) {
        list = parsed.filter((item) => typeof item === 'string');
    }
} catch {
    list = [];
}
if (!list.includes(rel)) {
    list.push(rel);
    fs.writeFileSync(pendingFile, JSON.stringify(list, null, 2), 'utf8');
}
