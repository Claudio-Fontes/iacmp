// A suíte asserta mensagens em português — fixa o idioma independente do SO
// do dev/CI. O smoke de EN fica em test/i18n.test.ts, que sobrescreve por env
// nos subprocessos.
process.env.IACMP_LANG = 'pt';
