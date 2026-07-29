/**
 * i18n do CLI — catálogo de mensagens por ID, 100% type-safe.
 *
 * Uso:
 *   msg('deploy.export-conflict', { stack, list })
 *
 * - O ID é checado em compile-time (keyof do catálogo) — chave inexistente
 *   não compila.
 * - Os parâmetros são checados pelo tipo da função da mensagem — parâmetro
 *   faltando/errado não compila.
 * - Mensagens vivem em src/i18n/messages/<domínio>.ts, agrupadas por área
 *   (commands, synth, deploy, validators, ...), com pt e en lado a lado.
 *
 * Para strings CURTAS pontuais ainda existe t(pt, en) (core.ts) — mas o
 * padrão do projeto é o catálogo.
 *
 * Resolução do idioma: IACMP_LANG > idioma do SO (pt* → pt) > en.
 */
import { currentLanguage } from './core';
import { CATALOG } from './messages';

export { t, currentLanguage, __setLanguageForTests, type Language } from './core';

type Catalog = typeof CATALOG;
export type MessageId = keyof Catalog;

type ParamsOf<K extends MessageId> =
  Catalog[K]['pt'] extends (p: infer P) => string ? [P] : [];

/**
 * Resolve a mensagem por (idioma, id, params) — o idioma é EXPLÍCITO.
 * Use quando precisar de um idioma específico independente do ambiente.
 */
export function msgIn<K extends MessageId>(
  lang: import('./core').Language,
  id: K,
  ...args: ParamsOf<K>
): string {
  const entry = CATALOG[id];
  const fn = (lang === 'pt' ? entry.pt : entry.en) as (p?: unknown) => string;
  return fn(args[0]);
}

/** Atalho no idioma corrente (IACMP_LANG > SO > en): msg('id') ou msg('id', params). */
export function msg<K extends MessageId>(id: K, ...args: ParamsOf<K>): string {
  return msgIn(currentLanguage(), id, ...args);
}
