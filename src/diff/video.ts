/** 仮置き（実装中）。 */
import { DiffDriver } from './types';

export const videoDriver: DiffDriver = {
    id: 'video',
    version: 0,
    label: 'video',
    matches: () => false,
    diff: async () => { throw new Error('not implemented'); },
};
