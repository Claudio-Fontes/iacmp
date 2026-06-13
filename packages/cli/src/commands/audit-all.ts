import { Command } from '@oclif/core';
import AuditSecurity from './audit-security';
import AuditHA from './audit-ha';
import AuditDR from './audit-dr';
import AuditImprovements from './audit-improvements';

export default class AuditAll extends Command {
  static description = 'Run all audits and generate all reports';
  static examples = ['$ iacmp audit-all'];

  async run(): Promise<void> {
    this.log('Running all audits...\n');
    await AuditSecurity.run([]);
    this.log('');
    await AuditHA.run([]);
    this.log('');
    await AuditDR.run([]);
    this.log('');
    await AuditImprovements.run([]);
    this.log('\nAll audits complete. Reports saved to audit/');
  }
}
