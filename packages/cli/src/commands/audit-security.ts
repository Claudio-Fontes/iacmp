import { Command } from '@oclif/core';
import chalk from 'chalk';
import { readConfig, loadStacks, saveReport, today } from '../audit';
import { BaseConstruct } from '@iacmp/core';
import { Stack } from '@iacmp/core';

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
  static description = 'Audit stacks for security issues';
  static examples = ['$ iacmp audit-security'];

  async run(): Promise<void> {
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

    let md = `# Security Audit Report — ${config.name}\n`;
    md += `Date: ${today()}\n`;
    md += `Provider: ${config.provider}\n\n`;
    md += `## Summary\n`;
    md += `- Critical issues: ${critical.length}\n`;
    md += `- Warnings: ${warnings.length}\n`;
    md += `- OK: ${allOk.length}\n\n`;
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
  }
}
