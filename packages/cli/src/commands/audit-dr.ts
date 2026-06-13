import { Command } from '@oclif/core';
import chalk from 'chalk';
import { readConfig, loadStacks, saveReport, today } from '../audit';
import { Stack } from '@iacmp/core';

interface DRCheck {
  label: string;
  passed: boolean;
}

interface DRDetail {
  level: 'no-dr' | 'warning' | 'ok' | 'info';
  title: string;
  detail: string;
  recommendation?: string;
}

interface StackDRResult {
  stackName: string;
  checks: DRCheck[];
  details: DRDetail[];
  score: number;
}

function analyzeStack(stackName: string, stack: Stack): StackDRResult {
  const constructs = stack.constructs;
  const checks: DRCheck[] = [];
  const details: DRDetail[] = [];

  const buckets = constructs.filter(c => c.type === 'Storage.Bucket');
  const dbs = constructs.filter(c => c.type === 'Database.SQL');
  const vpcs = constructs.filter(c => c.type === 'Network.VPC');
  const instances = constructs.filter(c => c.type === 'Compute.Instance');

  // Buckets with versioning
  const bucketsWithVersioning = buckets.filter(c => c.props.versioning === true);
  checks.push({
    label: 'Buckets with versioning enabled',
    passed: buckets.length === 0 || bucketsWithVersioning.length === buckets.length,
  });
  for (const b of buckets) {
    if (b.props.versioning !== true) {
      details.push({
        level: 'no-dr',
        title: `Storage.Bucket '${b.id}' — no versioning`,
        detail: 'Without versioning there is no object history. Deletions or overwrites are unrecoverable.',
        recommendation: 'Set `versioning: true`.',
      });
    }
  }

  // DBs Multi-AZ
  const dbsMultiAz = dbs.filter(c => c.props.multiAz === true);
  checks.push({
    label: 'Multi-AZ database',
    passed: dbs.length === 0 || dbsMultiAz.length === dbs.length,
  });
  for (const db of dbs) {
    if (db.props.multiAz !== true) {
      details.push({
        level: 'no-dr',
        title: `Database.SQL '${db.id}' — Single-AZ`,
        detail: 'Single-AZ database. In case of AZ failure, restore may take hours.',
        recommendation: 'Set `multiAz: true` for automatic failover.',
      });
    }
    if (db.props.instanceType === undefined || db.props.instanceType === null) {
      details.push({
        level: 'warning',
        title: `Database.SQL '${db.id}' — instanceType not defined`,
        detail: 'Default instance type may be insufficient for fast restore in DR scenarios.',
        recommendation: 'Set `instanceType` explicitly to ensure adequate performance.',
      });
    }
  }

  // VPC with multiple AZs
  const vpcsMultiAz = vpcs.filter(c => {
    const maxAzs = c.props.maxAzs as number | undefined;
    return maxAzs !== undefined && maxAzs >= 2;
  });
  checks.push({
    label: 'Network with multiple AZs',
    passed: vpcs.length === 0 || vpcsMultiAz.length === vpcs.length,
  });
  for (const vpc of vpcs) {
    const maxAzs = vpc.props.maxAzs as number | undefined;
    if (maxAzs === undefined || maxAzs < 2) {
      details.push({
        level: 'no-dr',
        title: `Network.VPC '${vpc.id}' — single AZ`,
        detail: `maxAzs is ${maxAzs ?? 'not defined'}. Single-AZ network compromises DR.`,
        recommendation: 'Set `maxAzs: 2` or more.',
      });
    }
  }

  // No persistent state
  if (dbs.length === 0 && buckets.length === 0) {
    details.push({
      level: 'info',
      title: 'No persistent state detected',
      detail: 'No Database.SQL or Storage.Bucket found. The stack may be stateless.',
    });
  }

  // Compute without storage
  if (instances.length > 0 && buckets.length === 0) {
    details.push({
      level: 'warning',
      title: 'Compute without storage detected',
      detail: 'Compute instances found but no storage bucket. Where will data be stored in a DR event?',
      recommendation: 'Consider adding a Storage.Bucket for persistent data.',
    });
  }

  const passed = checks.filter(c => c.passed).length;
  const total = checks.length;
  const score = total > 0 ? Math.round((passed / total) * 10) : 10;

  return { stackName, checks, details, score };
}

function scoreLabel(score: number): string {
  if (score <= 3) return 'Critical';
  if (score <= 5) return 'Below expectations';
  if (score <= 7) return 'Adequate';
  return 'Excellent';
}

export default class AuditDR extends Command {
  static description = 'Audit stacks for disaster recovery (DR) readiness';
  static examples = ['$ iacmp audit-dr'];

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

    const results: StackDRResult[] = [];
    for (const { name, stack } of stacks) {
      results.push(analyzeStack(name, stack));
    }

    const globalScore = results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 10;

    const scoreColor = globalScore <= 5 ? chalk.red : globalScore <= 7 ? chalk.yellow : chalk.green;

    this.log(chalk.bold('\nDisaster Recovery (DR) Audit'));
    this.log('─'.repeat(40));
    this.log(`DR Score: ${scoreColor(`${globalScore}/10`)} — ${scoreLabel(globalScore)}`);
    this.log('');

    for (const r of results) {
      for (const d of r.details) {
        if (d.level === 'no-dr') this.log(`${chalk.red('✗ [NO DR]')} ${d.title}`);
        else if (d.level === 'warning') this.log(`${chalk.yellow('⚠ [WARNING]')} ${d.title}`);
        else if (d.level === 'info') this.log(`${chalk.cyan('ℹ [INFO]')} ${d.title}`);
        else this.log(`${chalk.green('✓')} ${d.title}`);
      }
    }

    let md = `# Disaster Recovery (DR) Audit Report — ${config.name}\n`;
    md += `Date: ${today()}\n\n`;
    md += `## DR Score\n`;
    md += `${globalScore}/10 — ${scoreLabel(globalScore)}\n\n`;

    for (const r of results) {
      md += `## DR Checklist — Stack: ${r.stackName}\n`;
      for (const ch of r.checks) {
        md += `- [${ch.passed ? 'x' : ' '}] ${ch.label}\n`;
      }
      md += '\n';
    }

    md += `## Findings\n\n`;
    for (const r of results) {
      for (const d of r.details) {
        const label = d.level === 'no-dr' ? 'NO DR' : d.level === 'warning' ? 'WARNING' : d.level === 'info' ? 'INFO' : 'OK';
        md += `### [${label}] ${d.title}\n`;
        md += `Stack: ${r.stackName}\n`;
        md += `${d.detail}\n`;
        if (d.recommendation) md += `Recommendation: ${d.recommendation}\n`;
        md += '\n';
      }
    }

    const relPath = saveReport(cwd, 'dr', md);
    this.log(`\nReport saved to ${relPath}`);
  }
}
