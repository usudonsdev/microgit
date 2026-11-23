/**
 * 差分ドライバの一覧と選び方（docs/structured-diff.md §4）。VS Code に依存しない。
 * 並べた順に matches を試し、最初に当てはまったものを使う。最後の textDriver / binaryDriver は何にでも当てはまる。
 */
import { DiffDriver } from './types';
import { xlsxDriver } from './xlsx';
import { csvDriver } from './csv';
import { docxDriver } from './docx';
import { pptxDriver } from './pptx';
import { imageDriver } from './image';
import { videoDriver } from './video';
import { binaryDriver, textDriver } from './text';

export const DRIVERS: readonly DiffDriver[] = [
    xlsxDriver,
    docxDriver,
    pptxDriver,
    csvDriver,
    imageDriver,
    videoDriver,
    textDriver,
    binaryDriver,
];

/** path と、旧版か新版の先頭（最大 4 KiB）から、使うドライバを選ぶ */
export function selectDriver(path: string, head: Buffer): DiffDriver {
    for (const d of DRIVERS) {
        if (d.matches(path, head)) { return d; }
    }
    return binaryDriver;
}
