/** 仮置き（実装中）。 */
import { DiffDriver } from './types';

export const pptxDriver: DiffDriver = {
    id: 'pptx',
    version: 0,
    label: 'pptx',
    matches: () => false,
    diff: async () => { throw new Error('not implemented'); },
};
