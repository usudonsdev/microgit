import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { AGENT_HOOK_COMMAND, installAgentSkill } from '../../agentSkill';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('利用者向けエージェントスキル', () => {
    test('スキルとフックを置き、既存の hooks.json の他エントリは残す', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-skill-'));
        try {
            fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
            fs.writeFileSync(path.join(workspace, '.cursor', 'hooks.json'), `${JSON.stringify({
                version: 1,
                hooks: { stop: [{ command: 'echo keep' }] },
            })}\n`, 'utf8');

            const installed = installAgentSkill(repoRoot, workspace);
            assert.strictEqual(installed.hooksMerged, true);
            assert.strictEqual(fs.readFileSync(installed.skillPath, 'utf8').includes('name: use-microgit'), true);
            assert.strictEqual(fs.existsSync(installed.hookPath), true);

            const hooks = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'hooks.json'), 'utf8')) as {
                hooks: Record<string, Array<{ command: string }>>;
            };
            assert.strictEqual(hooks.hooks.stop[0].command, 'echo keep');
            assert.strictEqual(hooks.hooks.afterFileEdit[0].command, AGENT_HOOK_COMMAND);
            assert.strictEqual(hooks.hooks.afterTabFileEdit[0].command, AGENT_HOOK_COMMAND);

            const again = installAgentSkill(repoRoot, workspace);
            assert.strictEqual(again.hooksMerged, false);
            const reread = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'hooks.json'), 'utf8')) as {
                hooks: { afterFileEdit: unknown[] };
            };
            assert.strictEqual(reread.hooks.afterFileEdit.length, 1);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    test('壊れた hooks.json は上書きせず、スキルも置かない', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-skill-'));
        try {
            const hooksFile = path.join(workspace, '.cursor', 'hooks.json');
            fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
            fs.writeFileSync(hooksFile, '{', 'utf8');
            assert.throws(() => installAgentSkill(repoRoot, workspace), /読めない/);
            assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), '{');
            assert.strictEqual(fs.existsSync(path.join(workspace, '.cursor', 'skills')), false);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
});
