/** 仮置き（実装中）。 */
import { DiffDriver } from './types';

export const csvDriver: DiffDriver = { id: 'csv', version: 0, label: 'csv', matches: () => false, diff: async () => { throw new Error('not implemented'); } };
