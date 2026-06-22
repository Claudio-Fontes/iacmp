export type Language = 'pt' | 'en' | 'es';

export const SUPPORTED_LANGUAGES: Language[] = ['pt', 'en', 'es'];

export const DEFAULT_LANGUAGE: Language = 'pt';

export function resolveLanguage(value?: string | null): Language {
  const normalized = value?.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.includes(normalized as Language)
    ? (normalized as Language)
    : DEFAULT_LANGUAGE;
}
