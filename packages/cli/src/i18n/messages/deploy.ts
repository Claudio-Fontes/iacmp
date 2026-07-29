/** Mensagens do deploy/destroy (exemplo inicial — os domínios crescem na migração). */
export const deploy = {
  'deploy.export-conflict': {
    pt: (p: { stack: string; list: string }) =>
      `Deploy incremental bloqueado para a stack "${p.stack}": ${p.list}. ` +
      `O CloudFormation não deixa remover/renomear um export enquanto outra stack o importa. ` +
      `Costuma acontecer quando o projeto foi regenerado mudando a topologia (ex: 1 role compartilhada → N roles por handler). ` +
      `NÃO é update incremental — rode: iacmp destroy && iacmp deploy (recria limpo, sem estado antigo).`,
    en: (p: { stack: string; list: string }) =>
      `Incremental deploy blocked for stack "${p.stack}": ${p.list}. ` +
      `CloudFormation does not allow removing/renaming an export while another stack imports it. ` +
      `This usually happens when the project was regenerated with a different topology (e.g. 1 shared role → N roles per handler). ` +
      `This is NOT an incremental update — run: iacmp destroy && iacmp deploy (recreates cleanly, without old state).`,
  },
} as const;
