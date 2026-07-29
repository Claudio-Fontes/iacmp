/**
 * i18n do CLI aberto — bilíngue inline, sem catálogo de chaves.
 *
 * Uso: t('mensagem em português', 'message in english').
 * A tradução vive AO LADO do original — sem indireção, sem chave órfã, e o
 * diff de qualquer mudança mostra os dois idiomas juntos.
 *
 * Resolução do idioma (uma vez por processo):
 *   1. IACMP_LANG (env): pt → português; qualquer outro valor/ausente → inglês.
 *   2. Padrão: en (decisão de produto 2026-07-29 — produto global, inglês
 *      por default; PT é opt-in explícito via IACMP_LANG=pt).
 */

export type Language = 'pt' | 'en';

function detectLanguage(): Language {
  const forced = process.env.IACMP_LANG?.trim().toLowerCase();
  if (forced === 'pt' || forced === 'pt-br' || forced === 'pt_br') return 'pt';
  return 'en';
}

let lang: Language | null = null;

export function currentLanguage(): Language {
  if (lang === null) lang = detectLanguage();
  return lang;
}

/** Só para testes: força o idioma sem mexer no env. */
export function __setLanguageForTests(l: Language | null): void {
  lang = l;
}

/** Retorna a variante no idioma corrente. */
export function t(pt: string, en: string): string {
  return currentLanguage() === 'pt' ? pt : en;
}
