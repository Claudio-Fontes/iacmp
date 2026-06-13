import { Command } from '@oclif/core';
import chalk from 'chalk';
import { readConfig, loadStacks, saveReport, today } from '../audit';
import { Stack } from '@iacmp/core';

type HAStatus = 'no-ha' | 'ha-partial' | 'ha-ok' | 'info';

interface HAFinding {
  status: HAStatus;
  stackName: string;
  constructId: string;
  constructType: string;
  title: string;
  detail: string;
  recommendation: string;
}

function analyzeStack(stackName: string, stack: Stack): HAFinding[] {
  const findings: HAFinding[] = [];
  const constructs = stack.constructs;

  for (const c of constructs) {
    const p = c.props;

    if (c.type === 'Database.SQL') {
      if (p.multiAz !== true) {
        findings.push({
          status: 'no-ha',
          stackName,
          constructId: c.id,
          constructType: c.type,
          title: `Database.SQL '${c.id}' — Single-AZ`,
          detail: 'multiAz is not enabled. A failure in the AZ will make the database unavailable.',
          recommendation: 'Set `multiAz: true`.',
        });
      } else {
        findings.push({
          status: 'ha-ok',
          stackName,
          constructId: c.id,
          constructType: c.type,
          title: `Database.SQL '${c.id}' — Multi-AZ enabled`,
          detail: 'Database is configured with Multi-AZ.',
          recommendation: '',
        });
      }
    }

    if (c.type === 'Network.VPC') {
      const maxAzs = p.maxAzs as number | undefined;
      if (maxAzs === undefined || maxAzs === null || maxAzs < 2) {
        findings.push({
          status: 'no-ha',
          stackName,
          constructId: c.id,
          constructType: c.type,
          title: `Network.VPC '${c.id}' — single AZ`,
          detail: `maxAzs is ${maxAzs ?? 'not defined'} (< 2). The network is restricted to a single availability zone.`,
          recommendation: 'Set `maxAzs: 2` or more.',
        });
      } else {
        findings.push({
          status: 'ha-ok',
          stackName,
          constructId: c.id,
          constructType: c.type,
          title: `Network.VPC '${c.id}' — ${maxAzs} AZs`,
          detail: `Network is configured with ${maxAzs} availability zones.`,
          recommendation: '',
        });
      }
    }

    if (c.type === 'Function.Lambda') {
      findings.push({
        status: 'ha-ok',
        stackName,
        constructId: c.id,
        constructType: c.type,
        title: `Function.Lambda '${c.id}' — native HA`,
        detail: 'Lambda functions are distributed across multiple AZs by the provider by default.',
        recommendation: '',
      });
    }

    if (c.type === 'Storage.Bucket') {
      findings.push({
        status: 'ha-ok',
        stackName,
        constructId: c.id,
        constructType: c.type,
        title: `Storage.Bucket '${c.id}' — native HA`,
        detail: 'Object storage buckets are automatically replicated by the provider.',
        recommendation: '',
      });
    }
  }

  const vpcs = constructs.filter(c => c.type === 'Network.VPC');
  if (vpcs.length === 0) {
    findings.push({
      status: 'info',
      stackName,
      constructId: 'stack',
      constructType: 'Stack',
      title: `Stack '${stackName}' — no VPC`,
      detail: 'No Network.VPC found in the stack. No network isolation is defined.',
      recommendation: 'Consider adding a VPC to isolate network resources.',
    });
  }

  const instances = constructs.filter(c => c.type === 'Compute.Instance');
  if (instances.length === 1) {
    findings.push({
      status: 'info',
      stackName,
      constructId: instances[0].id,
      constructType: 'Compute.Instance',
      title: `Compute.Instance '${instances[0].id}' — no redundancy`,
      detail: 'Only 1 compute instance found. If it fails, there is no backup instance.',
      recommendation: 'Add more instances or configure auto-scaling.',
    });
  } else if (instances.length > 1) {
    for (const inst of instances) {
      findings.push({
        status: 'ha-ok',
        stackName,
        constructId: inst.id,
        constructType: 'Compute.Instance',
        title: `Compute.Instance '${inst.id}' — redundancy detected`,
        detail: `${instances.length} compute instances in the stack.`,
        recommendation: '',
      });
    }
  }

  return findings;
}

export default class AuditHA extends Command {
  static description = 'Audit stacks for high availability (HA) issues';
  static examples = ['$ iacmp audit-ha'];

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

    const allFindings: HAFinding[] = [];
    for (const { name, stack } of stacks) {
      allFindings.push(...analyzeStack(name, stack));
    }

    const noHA = allFindings.filter(f => f.status === 'no-ha');
    const partial = allFindings.filter(f => f.status === 'ha-partial');
    const haOk = allFindings.filter(f => f.status === 'ha-ok');
    const infos = allFindings.filter(f => f.status === 'info');

    this.log(chalk.bold('\nHigh Availability (HA) Audit'));
    this.log('─'.repeat(40));
    this.log(`No HA:    ${noHA.length > 0 ? chalk.red(noHA.length) : chalk.green(0)}`);
    this.log(`Partial:  ${partial.length > 0 ? chalk.yellow(partial.length) : chalk.green(0)}`);
    this.log(`HA OK:    ${chalk.green(haOk.length)}`);
    this.log('');

    for (const f of noHA) {
      this.log(`${chalk.red('✗ [NO HA]')} ${f.title}`);
    }
    for (const f of partial) {
      this.log(`${chalk.yellow('⚠ [PARTIAL HA]')} ${f.title}`);
    }
    for (const f of infos) {
      this.log(`${chalk.yellow('⚠ [WARNING]')} ${f.title}`);
    }
    for (const f of haOk) {
      this.log(`${chalk.green('✓ [HA OK]')} ${f.title}`);
    }

    let md = `# High Availability (HA) Audit Report — ${config.name}\n`;
    md += `Date: ${today()}\n\n`;
    md += `## Summary\n`;
    md += `- No HA: ${noHA.length} resources\n`;
    md += `- Partial HA: ${partial.length} resources\n`;
    md += `- HA OK: ${haOk.length} resources\n\n`;
    md += `## Findings\n\n`;

    for (const f of [...noHA, ...partial, ...infos]) {
      const label = f.status === 'no-ha' ? 'NO HA' : f.status === 'ha-partial' ? 'PARTIAL HA' : 'WARNING';
      md += `### [${label}] ${f.title}\n`;
      md += `Stack: ${f.stackName}\n`;
      md += `${f.detail}\n`;
      if (f.recommendation) md += `Recommendation: ${f.recommendation}\n`;
      md += '\n';
    }

    if (haOk.length > 0) {
      md += `## Resources with HA\n`;
      for (const f of haOk) {
        md += `- ${f.constructType} '${f.constructId}' — HA OK\n`;
      }
      md += '\n';
    }

    const relPath = saveReport(cwd, 'ha', md);
    this.log(`\nReport saved to ${relPath}`);
  }
}
