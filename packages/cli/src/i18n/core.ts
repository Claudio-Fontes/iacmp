/**
 * i18n do CLI aberto — bilíngue inline, sem catálogo de chaves.
 *
 * Uso: t('mensagem em português', 'message in english').
 * A tradução vive AO LADO do original — sem indireção, sem chave órfã, e o
 * diff de qualquer mudança mostra os dois idiomas juntos.
 *
 * Resolução do idioma (uma vez por processo):
 *   1. IACMP_LANG (env — pode vir do ~/.iacmp/config ou do .env do projeto
 *      via env-loader, ou exportada no shell)
 *   2. Idioma do sistema (LC_ALL / LC_MESSAGES / LANG): pt* → pt; resto → en
 *   3. Fallback: en (produto global — quem não sinaliza nada vê inglês)
 *
 * Brasileiro com o SO em pt-BR vê português sem configurar nada.
 */

export type Language = 'pt' | 'en';

function detectLanguage(): Language {
  const forced = process.env.IACMP_LANG?.trim().toLowerCase();
  if (forced === 'pt' || forced === 'pt-br' || forced === 'pt_br') return 'pt';
  if (forced === 'en') return 'en';

  const sys = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
    .trim().toLowerCase();
  if (sys.startsWith('pt')) return 'pt';
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
