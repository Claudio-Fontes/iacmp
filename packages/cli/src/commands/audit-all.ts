import { Command, Flags } from '@oclif/core';
import AuditSecurity from './audit-security';
import AuditHA from './audit-ha';
import AuditDR from './audit-dr';
import AuditImprovements from './audit-improvements';

export default class AuditAll extends Command {
  static description = 'Run all audits and generate all reports';
  static examples = [
    '$ iacmp audit-all',
    '$ iacmp audit-all --fail-on=critical',
  ];

  static flags = {
    'fail-on': Flags.string({
      description: 'Sai com exit 1 quando qualquer audit acusa achados no nível indicado',
      options: ['critical', 'warning', 'none'],
      default: 'none',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditAll);
    const failOnArgs = flags['fail-on'] === 'none' ? [] : [`--fail-on=${flags['fail-on']}`];

    this.log('Running all audits...\n');
    let anyFailed = false;
    let hardError: Error | null = null;
    // Rodamos cada audit como subcomando; --fail-on em qualquer um dispara
    // ExitError com code 1 — capturamos e seguimos. Erros "hard" (this.error,
    // ex.: iacmp.json ausente) saem com code 2 e abortam imediatamente, mas
    // preservamos a mensagem original.
    for (const Cmd of [AuditSecurity, AuditHA, AuditDR, AuditImprovements]) {
      try {
        await Cmd.run(failOnArgs);
      } catch (e) {
        const code = (e as { oclif?: { exit?: number } }).oclif?.exit;
        if (code === 1) {
          anyFailed = true;
        } else {
          hardError = e as Error;
          break;
        }
      }
      this.log('');
    }

    if (hardError) {
      this.error(hardError.message);
    }

    this.log('All audits complete. Reports saved to audit/');

    if (anyFailed) this.exit(1);
  }
}
