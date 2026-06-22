import { resolveLanguage, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../src/i18n/languages';
import { MESSAGES } from '../src/i18n/messages';

describe('resolveLanguage', () => {
  test('aceita pt, en, es', () => {
    expect(resolveLanguage('pt')).toBe('pt');
    expect(resolveLanguage('en')).toBe('en');
    expect(resolveLanguage('es')).toBe('es');
  });

  test('normaliza maiusculas e espacos', () => {
    expect(resolveLanguage(' EN ')).toBe('en');
  });

  test('cai no default quando vazio, undefined ou invalido', () => {
    expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage('')).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage('fr')).toBe(DEFAULT_LANGUAGE);
  });
});

describe('MESSAGES', () => {
  test('tem entrada para cada idioma suportado', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(MESSAGES[lang]).toBeDefined();
    }
  });

  test('todas as secoes existem nos 3 idiomas', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(MESSAGES[lang].chat).toBeDefined();
      expect(MESSAGES[lang].chat.voice).toBeDefined();
      expect(MESSAGES[lang].renderer).toBeDefined();
      expect(MESSAGES[lang].diff).toBeDefined();
      expect(MESSAGES[lang].fileWriter).toBeDefined();
      expect(MESSAGES[lang].fileDeleter).toBeDefined();
    }
  });
});
