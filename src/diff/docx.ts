/** 仮置き（実装中）。 */
import { DiffDriver } from './types';

export const docxDriver: DiffDriver = {
    id: 'docx',
    version: 0,
    label: 'docx',
    matches: () => false,
    diff: async () => { throw new Error('not implemented'); },
};
