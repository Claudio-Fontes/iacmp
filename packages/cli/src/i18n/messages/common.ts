/** Mensagens transversais (gates, init de projeto, binários ausentes). */
export const common = {
  'common.not-initialized': {
    pt: () => 'Projeto não inicializado. Rode: iacmp init',
    en: () => 'Project not initialized. Run: iacmp init',
  },
  'common.binary-missing': {
    pt: (p: { bin: string }) => `${p.bin} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`,
    en: (p: { bin: string }) => `${p.bin} not found in PATH. Run: iacmp doctor --fix (or install it manually) and try again.`,
  },
  'common.pro-feature': {
    pt: () =>
      'Este recurso faz parte do iacmp Pro (geração via IA com corpus validado em deploy real).\n' +
      'O restante do CLI (init/synth/deploy/destroy/diff/diagram) funciona normalmente sem ele.\n' +
      'Saiba mais: https://github.com/Claudio-Fontes/iacmp#iacmp-pro',
    en: () =>
      'This feature is part of iacmp Pro (AI generation backed by a deploy-validated corpus).\n' +
      'The rest of the CLI (init/synth/deploy/destroy/diff/diagram) works fully without it.\n' +
      'Learn more: https://github.com/Claudio-Fontes/iacmp#iacmp-pro',
  },
} as const;
