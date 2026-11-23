/** テスト用：PATH から ffmpeg・ffprobe を探す（diffCommand.ts の resolveTools と同じ考え。VS Code を読み込まないため別にした） */
import * as fs from 'fs';
import { findInPath } from '../../../kernel/launchers';

export function resolveToolsForTest(): { ffmpegPath?: string; ffprobePath?: string } {
    const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    return {
        ffmpegPath: findInPath('ffmpeg', process.env, process.platform, exists),
        ffprobePath: findInPath('ffprobe', process.env, process.platform, exists),
    };
}
