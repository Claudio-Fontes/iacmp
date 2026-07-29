import { common } from './common';
import { deploy } from './deploy';

/**
 * Catálogo agregado. Cada domínio exporta um objeto `{ 'dominio.id': { pt, en } }`
 * onde pt/en são `() => string` ou `(p: {...}) => string` (o tipo dos params é
 * verificado no call site pelo msg()).
 */
export const CATALOG = {
  ...common,
  ...deploy,
} as const;
