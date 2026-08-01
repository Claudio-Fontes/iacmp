import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { t } from '../i18n';
import { auditArtifacts } from '../audit/artifact';
import { readConfig, loadStacks, saveReport, today } from '../audit';
import { BaseConstruct } from '@iacmp/core';
import { Stack } from '@iacmp/core';

type FailOn = 'critical' | 'warning' | 'none';

function shouldFail(failOn: FailOn, critical: number, warnings: number): boolean {
  if (failOn === 'critical') return critical > 0;
  if (failOn === 'warning') return critical > 0 || warnings > 0;
  return false;
}

interface Finding {
  level: 'critical' | 'warning' | 'ok';
  stackName: string;
  construct: BaseConstruct;
  title: string;
  problem: string;
  recommendation: string;
}

function analyzeStack(stackName: string, stack: Stack): { findings: Finding[]; ok: BaseConstruct[] } {
  const findings: Finding[] = [];
  const ok: BaseConstruct[] = [];

  for (const c of stack.constructs) {
    const p = c.props;
    let hasIssue = false;

    if (c.type === 'Storage.Bucket') {
      if (p.publicAccess === true) {
        findings.push({
          level: 'critical',
          stackName,
          construct: c,
          title: `Storage.Bucket '${c.id}' — public access enabled`,
          problem: 'publicAccess is enabled. Anyone can read/list objects in this bucket.',
          recommendation: 'Set `publicAccess: false` unless this is an intentional static website bucket.',
        });
        hasIssue = true;
      }
      if (p.versioning !== true) {
        findings.push({
          level: 'warning',
          stackName,
          construct: c,
          title: `Storage.Bucket '${c.id}' — versioning disabled`,
          problem: 'Versioning is not enabled. Deleted or overwritten objects cannot be recovered.',
          recommendation: 'Set `versioning: true` to enable object rollback.',
        });
        hasIssue = true;
      }
    }

    if (c.type === 'Database.SQL') {
      if (p.multiAz !== true) {
        findings.push({
          level: 'warning',
          stackName,
          construct: c,
          title: `Database.SQL '${c.id}' — no Multi-AZ`,
          problem: 'multiAz is not enabled. A failure in the availability zone will make the database unavailable.',
          recommendation: 'Set `multiAz: true` for high availability.',
        });
        hasIssue = true;
      }
    }

    if (c.type === 'Function.Lambda') {
      if (p.memory === undefined || p.memory === null) {
        findings.push({
          level: 'warning',
          stackName,
          construct: c,
          title: `Function.Lambda '${c.id}' — memory not defined`,
          problem: 'memory is not set. The function will use the provider default, which may be insufficient.',
          recommendation: 'Set `memory` explicitly (e.g. 256 or 512 MB).',
        });
        hasIssue = true;
      }
    }

    if (c.type === 'Network.VPC') {
      if (p.cidr === undefined || p.cidr === null) {
        findings.push({
          level: 'warning',
          stackName,
          construct: c,
          title: `Network.VPC '${c.id}' — default CIDR`,
          problem: 'cidr is not defined. The provider default CIDR may conflict with existing networks.',
          recommendation: 'Set `cidr` explicitly (e.g. "10.0.0.0/16").',
        });
        hasIssue = true;
      }
    }

    if (c.type === 'Compute.Instance') {
      if (p.publicAccess === true) {
        findings.push({
          level: 'critical',
          stackName,
          construct: c,
          title: `Compute.Instance '${c.id}' — public access enabled`,
          problem: 'publicAccess is enabled. The instance is directly exposed to the internet.',
          recommendation: 'Disable public access and use a load balancer or bastion host.',
        });
        hasIssue = true;
      }
    }

    if (!hasIssue) ok.push(c);
  }

  return { findings, ok };
}

export default class AuditSecurity extends Command {
  static description = t('Audita as stacks em busca de problemas de segurança', 'Audit stacks for security issues');
  static examples = [
    '$ iacmp audit-security',
    '$ iacmp audit-security --fail-on=critical',
    '$ iacmp audit-security --fail-on=warning',
  ];

  static flags = {
    'fail-on': Flags.string({
      description: t('Sai com exit 1 quando há achados no nível indicado', 'Exits with code 1 when there are findings at the given level'),
      options: ['critical', 'warning', 'none'],
      default: 'none',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditSecurity);
    const failOn = flags['fail-on'] as FailOn;
    const cwd = process.cwd();
    let config;
    try {
      config = readConfig(cwd);
    } catch (err) {
      this.error((err as Error).message);
    }

    let stacks;
    try {
      stacks = loadStacks(cwd);
    } catch (err) {
      this.error((err as Error).message);
    }

    const allFindings: Finding[] = [];
    const allOk: BaseConstruct[] = [];

    for (const { name, stack } of stacks) {
      const { findings, ok } = analyzeStack(name, stack);
      allFindings.push(...findings);
      allOk.push(...ok);
    }

    const critical = allFindings.filter(f => f.level === 'critical');
    const warnings = allFindings.filter(f => f.level === 'warning');

    this.log(chalk.bold('\nSecurity Audit'));
    this.log('─'.repeat(40));
    this.log(`Critical issues: ${critical.length > 0 ? chalk.red(critical.length) : chalk.green(0)}`);
    this.log(`Warnings:        ${warnings.length > 0 ? chalk.yellow(warnings.length) : chalk.green(0)}`);
    this.log(`OK:              ${chalk.green(allOk.length)}`);
    this.log('');

    for (const f of critical) {
      this.log(`${chalk.red('✗ [CRITICAL]')} ${f.title}`);
    }
    for (const f of warnings) {
      this.log(`${chalk.yellow('⚠ [WARNING]')} ${f.title}`);
    }
    for (const c of allOk) {
      this.log(`${chalk.green('✓')} ${c.type} '${c.id}' — OK`);
    }

    // ── Auditoria do ARTEFATO FINAL ────────────────────────────────────────
    // O bloco acima analisou os constructs (o que o usuário escreveu). Aqui
    // olhamos o que REALMENTE vai para a nuvem — é onde moram os achados de
    // policy ampla, porta aberta e rota sem auth (auditoria P2-01, 2026-08-01).
    const artifact = auditArtifacts(cwd, config.provider);
    this.log('');
    this.log(chalk.bold(t('Artefatos sintetizados', 'Synthesized artifacts')));
    this.log('─'.repeat(40));
    if (artifact.filesAnalyzed.length === 0) {
      this.log(chalk.yellow(t(
        'Nenhum artefato encontrado — rode `iacmp synth` para auditar o que será criado na nuvem.',
        'No artifacts found — run `iacmp synth` to audit what will actually be created in the cloud.')));
    } else {
      this.log(t(`Arquivos analisados: ${artifact.filesAnalyzed.length}`, `Files analyzed: ${artifact.filesAnalyzed.length}`));
      for (const f of artifact.findings) {
        const tag = f.level === 'critical' ? chalk.red('✗ [CRITICAL]') : chalk.yellow('⚠ [WARNING]');
        this.log(`${tag} ${f.detail} ${chalk.dim(`(${f.file})`)}`);
      }
      // Estados explícitos: PASS só quando o check teve alvo para analisar.
      for (const c of artifact.checked) {
        if (c.status === 'FAIL') continue;
        const label = c.status === 'PASS' ? chalk.green('✓ PASS')
          : c.status === 'NOT_APPLICABLE' ? chalk.dim('· N/A')
          : chalk.yellow('? NOT CHECKED');
        this.log(`${label} ${chalk.dim(c.check)}`);
      }
    }

    const artifactCritical = artifact.findings.filter(f => f.level === 'critical');
    const artifactWarnings = artifact.findings.filter(f => f.level === 'warning');

    let md = `# Security Audit Report — ${config.name}\n`;
    md += `Date: ${today()}\n`;
    md += `Provider: ${config.provider}\n\n`;
    md += `## Summary\n`;
    md += `- Critical issues: ${critical.length}\n`;
    md += `- Warnings: ${warnings.length}\n`;
    md += `- OK: ${allOk.length}\n\n`;
    md += `## Artifact checks (${artifact.filesAnalyzed.length} file(s) analyzed)\n`;
    if (artifact.filesAnalyzed.length === 0) {
      md += `- NOT CHECKED: no synthesized artifacts found (run \`iacmp synth\` first)\n\n`;
    } else {
      for (const c of artifact.checked) md += `- ${c.check}: ${c.status}\n`;
      md += '\n';
      for (const f of artifact.findings) {
        md += `### [${f.level.toUpperCase()}] ${f.check}\n`;
        md += `File: ${f.file}\n`;
        md += `Detail: ${f.detail}\n\n`;
      }
    }

    md += `## Findings\n\n`;

    for (const f of allFindings) {
      const label = f.level === 'critical' ? 'CRITICAL' : 'WARNING';
      md += `### [${label}] ${f.title}\n`;
      md += `Stack: ${f.stackName}\n`;
      md += `Resource: ${f.construct.id} (${f.construct.type})\n`;
      md += `Problem: ${f.problem}\n`;
      md += `Recommendation: ${f.recommendation}\n\n`;
    }

    if (allOk.length > 0) {
      md += `## Resources with no issues\n`;
      for (const c of allOk) {
        md += `- ${c.type} '${c.id}' — OK\n`;
      }
      md += '\n';
    }

    const relPath = saveReport(cwd, 'security', md);
    this.log(`\nReport saved to ${relPath}`);

    if (shouldFail(failOn, critical.length + artifactCritical.length, warnings.length + artifactWarnings.length)) {
      this.exit(1);
    }
  }
}
