import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { readConfig, loadStacks, saveReport, today } from '../audit';
import { Stack } from '@iacmp/core';

type FailOn = 'critical' | 'warning' | 'none';

function shouldFail(failOn: FailOn, critical: number, warnings: number): boolean {
  if (failOn === 'critical') return critical > 0;
  if (failOn === 'warning') return critical > 0 || warnings > 0;
  return false;
}

interface Improvement {
  category: string;
  constructId: string;
  constructType: string;
  stackName: string;
  title: string;
  impact: 'High' | 'Medium' | 'Low';
  current: string;
  suggestion: string;
  effort: string;
}

function analyzeStack(stackName: string, stack: Stack): { improvements: Improvement[]; ok: Array<{ id: string; type: string; reason: string }> } {
  const constructs = stack.constructs;
  const improvements: Improvement[] = [];
  const ok: Array<{ id: string; type: string; reason: string }> = [];

  if (constructs.length === 0) {
    improvements.push({
      category: 'CONFIGURATION',
      constructId: stackName,
      constructType: 'Stack',
      stackName,
      title: `Stack '${stackName}' — empty`,
      impact: 'High',
      current: 'The stack has no constructs defined.',
      suggestion: 'Add constructs to the stack to make it functional.',
      effort: 'Varies by use case',
    });
    return { improvements, ok };
  }

  const instances = constructs.filter(c => c.type === 'Compute.Instance');
  const buckets = constructs.filter(c => c.type === 'Storage.Bucket');
  const dbs = constructs.filter(c => c.type === 'Database.SQL');
  const lambdas = constructs.filter(c => c.type === 'Function.Lambda');
  const vpcs = constructs.filter(c => c.type === 'Network.VPC');

  for (const inst of instances) {
    if (inst.props.instanceType === 'small') {
      improvements.push({
        category: 'PERFORMANCE',
        constructId: inst.id,
        constructType: inst.type,
        stackName,
        title: `Compute.Instance '${inst.id}' — small instance type`,
        impact: 'Medium',
        current: `instanceType 'small' may be insufficient for production workloads.`,
        suggestion: `Use 'medium' or 'large' for production. Consider adding auto-scaling.`,
        effort: 'Low (change 1 field in the stack)',
      });
    } else {
      ok.push({ id: inst.id, type: inst.type, reason: 'adequate instance type' });
    }
  }

  if (instances.length > 1) {
    improvements.push({
      category: 'ARCHITECTURE',
      constructId: 'stack',
      constructType: 'Stack',
      stackName,
      title: 'Multiple instances without a load balancer',
      impact: 'High',
      current: `${instances.length} compute instances detected with no load balancer defined.`,
      suggestion: 'Add a load balancer to distribute traffic and increase resilience. (future feature in iacmp)',
      effort: 'Medium (requires new resource in iacmp)',
    });
  }

  for (const b of buckets) {
    if (b.props.versioning !== true) {
      improvements.push({
        category: 'DATA PROTECTION',
        constructId: b.id,
        constructType: b.type,
        stackName,
        title: `Storage.Bucket '${b.id}' — versioning disabled`,
        impact: 'Medium',
        current: 'Versioning is disabled. Deleted or overwritten objects are unrecoverable.',
        suggestion: 'Enable `versioning: true` to protect against accidental deletion.',
        effort: 'Low (change 1 field in the stack)',
      });
    } else {
      ok.push({ id: b.id, type: b.type, reason: 'versioning enabled' });
    }
  }

  for (const db of dbs) {
    if (db.props.multiAz !== true) {
      improvements.push({
        category: 'AVAILABILITY',
        constructId: db.id,
        constructType: db.type,
        stackName,
        title: `Database.SQL '${db.id}' — no Multi-AZ or read replica`,
        impact: 'High',
        current: 'Single-AZ database with no read replica.',
        suggestion: 'Set `multiAz: true` and consider adding a read replica for query performance.',
        effort: 'Low (change 1 field; replica requires a new construct)',
      });
    } else {
      ok.push({ id: db.id, type: db.type, reason: 'Multi-AZ enabled' });
    }
  }

  for (const vpc of vpcs) {
    const maxAzs = vpc.props.maxAzs as number | undefined;
    if (maxAzs === undefined || maxAzs === null) {
      improvements.push({
        category: 'ARCHITECTURE',
        constructId: vpc.id,
        constructType: vpc.type,
        stackName,
        title: `Network.VPC '${vpc.id}' — maxAzs not defined`,
        impact: 'Medium',
        current: 'maxAzs not defined. The provider may default to 1 AZ.',
        suggestion: 'Set `maxAzs: 3` for production with high availability.',
        effort: 'Low (change 1 field in the stack)',
      });
    } else {
      ok.push({ id: vpc.id, type: vpc.type, reason: `${maxAzs} AZs configured` });
    }
  }

  if (lambdas.length === 0 && instances.length > 0) {
    improvements.push({
      category: 'ARCHITECTURE',
      constructId: 'stack',
      constructType: 'Stack',
      stackName,
      title: 'No serverless functions detected',
      impact: 'Low',
      current: `Stack has ${instances.length} compute instance(s) but no Function.Lambda.`,
      suggestion: 'For event-driven tasks, scheduled jobs, or webhooks, consider Function.Lambda instead of always-on instances.',
      effort: 'Medium (requires partial logic refactoring)',
    });
  }

  for (const fn of lambdas) {
    ok.push({ id: fn.id, type: fn.type, reason: 'serverless — cost-efficient by nature' });
  }

  return { improvements, ok };
}

export default class AuditImprovements extends Command {
  static description = 'Suggest architecture and performance improvements for stacks';
  static examples = [
    '$ iacmp audit-improvements',
    '$ iacmp audit-improvements --fail-on=critical',
  ];

  static flags = {
    'fail-on': Flags.string({
      description: 'Sai com exit 1 quando há melhorias no nível indicado (critical = High impact, warning = qualquer)',
      options: ['critical', 'warning', 'none'],
      default: 'none',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditImprovements);
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

    const allImprovements: Improvement[] = [];
    const allOk: Array<{ id: string; type: string; reason: string; stackName: string }> = [];

    for (const { name, stack } of stacks) {
      const { improvements, ok } = analyzeStack(name, stack);
      allImprovements.push(...improvements);
      for (const o of ok) allOk.push({ ...o, stackName: name });
    }

    this.log(chalk.bold('\nImprovements Audit'));
    this.log('─'.repeat(40));
    this.log(`Improvements found: ${allImprovements.length > 0 ? chalk.yellow(allImprovements.length) : chalk.green(0)}`);
    this.log('');

    for (const m of allImprovements) {
      const impactColor = m.impact === 'High' ? chalk.red : m.impact === 'Medium' ? chalk.yellow : chalk.cyan;
      this.log(`${chalk.yellow('⚠')} [${m.category}] ${m.title} — Impact: ${impactColor(m.impact)}`);
    }
    for (const o of allOk) {
      this.log(`${chalk.green('✓')} ${o.type} '${o.id}' — ${o.reason}`);
    }

    let md = `# Improvements Audit Report — ${config.name}\n`;
    md += `Date: ${today()}\n\n`;
    md += `## Improvements found: ${allImprovements.length}\n\n`;

    for (const m of allImprovements) {
      md += `### [${m.category}] ${m.title}\n`;
      md += `Impact: ${m.impact}\n`;
      md += `Stack: ${m.stackName}\n`;
      md += `Current situation: ${m.current}\n`;
      md += `Suggestion: ${m.suggestion}\n`;
      md += `Estimated effort: ${m.effort}\n\n`;
    }

    if (allOk.length > 0) {
      md += `## No suggestions\n`;
      for (const o of allOk) {
        md += `- ${o.type} '${o.id}' — ${o.reason}\n`;
      }
      md += '\n';
    }

    const relPath = saveReport(cwd, 'improvements', md);
    this.log(`\nReport saved to ${relPath}`);

    const highImpact = allImprovements.filter(m => m.impact === 'High').length;
    const otherImpact = allImprovements.length - highImpact;
    if (shouldFail(failOn, highImpact, otherImpact)) {
      this.exit(1);
    }
  }
}
