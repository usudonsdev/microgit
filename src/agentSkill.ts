import * as fs from 'fs';
import * as path from 'path';

/** 拡張機能利用者が Cursor に置くスキル名。 */
export const AGENT_SKILL_DIR = 'use-microgit';

/** Cursor のフックから同梱スクリプトを呼ぶコマンド。 */
export const AGENT_HOOK_COMMAND = 'node .cursor/hooks/mark-ai-edit.mjs';

const HOOK_EVENTS = ['afterFileEdit', 'afterTabFileEdit'] as const;

export interface AgentSkillInstallResult {
    skillPath: string;
    hookPath: string;
    /** hooks.json に新しいエントリを足したとき true。既にあれば false。 */
    hooksMerged: boolean;
}

export function agentSkillMarker(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.cursor', 'skills', AGENT_SKILL_DIR, 'SKILL.md');
}

/**
 * ワークスペースへスキルと AI 編集フックを置く。
 * hooks.json が壊れているときは何も書かない。
 */
export function installAgentSkill(extensionRoot: string, workspaceRoot: string): AgentSkillInstallResult {
    const sourceDir = path.join(extensionRoot, 'skills', AGENT_SKILL_DIR);
    const skillSource = path.join(sourceDir, 'SKILL.md');
    const hookSource = path.join(sourceDir, 'hooks', 'mark-ai-edit.mjs');
    if (!fs.existsSync(skillSource) || !fs.existsSync(hookSource)) {
        throw new Error('同梱のエージェントスキルが見つかりません');
    }

    const hooksFile = path.join(workspaceRoot, '.cursor', 'hooks.json');
    const planned = planCursorHook(hooksFile);
    const skillPath = agentSkillMarker(workspaceRoot);
    const hookPath = path.join(workspaceRoot, '.cursor', 'hooks', 'mark-ai-edit.mjs');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.copyFileSync(skillSource, skillPath);
    fs.copyFileSync(hookSource, hookPath);
    if (planned.changed) {
        fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
        fs.writeFileSync(hooksFile, planned.text, 'utf8');
    }
    return { skillPath, hookPath, hooksMerged: planned.changed };
}

/** 既存の hooks.json を残したまま、AI 編集フックが無ければ足す。 */
export function mergeCursorHook(hooksFile: string): boolean {
    const planned = planCursorHook(hooksFile);
    if (planned.changed) {
        fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
        fs.writeFileSync(hooksFile, planned.text, 'utf8');
    }
    return planned.changed;
}

function planCursorHook(hooksFile: string): { changed: boolean; text: string } {
    const current = readHooks(hooksFile);
    const hooks = isRecord(current.hooks) ? { ...current.hooks } : {};
    let changed = !fs.existsSync(hooksFile);
    for (const eventName of HOOK_EVENTS) {
        const existing = hooks[eventName];
        const entries = Array.isArray(existing) ? [...existing] : [];
        const exists = entries.some((entry) =>
            isRecord(entry) && typeof entry.command === 'string' && entry.command.includes('mark-ai-edit')
        );
        if (exists) {
            hooks[eventName] = entries;
            continue;
        }
        entries.push({ command: AGENT_HOOK_COMMAND, timeout: 15 });
        hooks[eventName] = entries;
        changed = true;
    }
    return {
        changed,
        text: `${JSON.stringify({ ...current, version: current.version ?? 1, hooks }, null, 2)}\n`,
    };
}

function readHooks(hooksFile: string): Record<string, unknown> {
    if (!fs.existsSync(hooksFile)) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        if (!isRecord(parsed)) {
            throw new Error('オブジェクトではない');
        }
        return parsed;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${hooksFile} を読めないため、エージェントスキルのフックを足せません: ${message}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
