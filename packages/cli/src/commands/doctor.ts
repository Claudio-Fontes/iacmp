import { Command, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { readJsonFile } from '../utils';

interface Check {
  label: string;
  ok: boolean;
  /** required=true => falha derruba o exit code mesmo sem --strict. */
  required: boolean;
  value?: string;
  hint?: string;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function checkNode(): Check {
  const out = tryExec('node --version');
  if (!out) return { label: 'Node.js', ok: false, required: true, hint: 'Instale em: https://nodejs.org' };
  const version = out.replace('v', '');
  const major = parseInt(version.split('.')[0], 10);
  return {
    label: 'Node.js',
    ok: major >= 20,
    required: true,
    value: out,
    hint: major < 20 ? 'Node.js 20+ é necessário.' : undefined,
  };
}

function checkNpm(): Check {
  const out = tryExec('npm --version');
  if (!out) return { label: 'npm', ok: false, required: true, hint: 'Instale Node.js (npm vem junto).' };
  return { label: 'npm', ok: true, required: true, value: `v${out}` };
}

function checkIacmp(): Check {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  try {
    const pkg = readJsonFile<{ version: string }>(pkgPath);
    return { label: 'iacmp', ok: true, required: false, value: `v${pkg.version}` };
  } catch {
    return { label: 'iacmp', ok: false, required: false, hint: 'package.json não encontrado' };
  }
}

function checkAwsCli(): Check {
  const out = tryExec('aws --version');
  if (!out) return { label: 'AWS CLI', ok: false, required: false, hint: 'Instale com: brew install awscli' };
  const version = out.split('/')[1]?.split(' ')[0] ?? out;
  return { label: 'AWS CLI', ok: true, required: false, value: version };
}

function checkAnthropicKey(): Check {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    label: 'ANTHROPIC_API_KEY',
    ok: true,
    required: false,
    value: key ? 'configurado' : 'não configurado (necessário para iacmp ai)',
  };
}

export default class Doctor extends Command {
  static description = 'Verifica o ambiente e dependências do iacmp';

  static examples = [
    '$ iacmp doctor',
    '$ iacmp doctor --strict',
  ];

  static flags = {
    strict: Flags.boolean({
      description: 'Falha (exit 1) também para checagens opcionais (AWS CLI, etc.)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    this.log('Verificando ambiente...\n');

    const checks: Check[] = [
      checkNode(),
      checkNpm(),
      checkIacmp(),
      checkAwsCli(),
      checkAnthropicKey(),
    ];

    for (const check of checks) {
      const icon = check.ok ? '✓' : '✗';
      const status = check.value ? `${check.label} ${check.value}` : check.label;
      if (check.ok) {
        this.log(`  ${icon} ${status}`);
      } else {
        this.log(`  ${icon} ${check.label} nao encontrado`);
        if (check.hint) {
          this.log(`      ${check.hint}`);
        }
      }
    }

    this.log('');
    const allOk = checks.every(c => c.ok);
    if (allOk) {
      this.log('Ambiente OK. Pronto para uso.');
    } else {
      this.log('Alguns itens precisam de atenção.');
    }

    // Verifica plugins do projeto atual
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');
    if (fs.existsSync(configPath)) {
      let config: { plugins?: string[] } = {};
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {}

      if (config.plugins && config.plugins.length > 0) {
        this.log('\nPlugins do projeto:');

        for (const pluginName of config.plugins) {
          let found = false;
          let providerNames: string[] = [];
          try {
            const pluginPath = require.resolve(pluginName, { paths: [cwd] });
            const mod = require(pluginPath) as { providers?: Array<{ name: string }> };
            if (Array.isArray(mod.providers)) {
              found = true;
              providerNames = mod.providers.map(p => p.name);
            }
          } catch {}

          const icon = found ? '✓' : '✗';
          const detail = found
            ? `(providers: ${providerNames.join(', ')})`
            : 'não encontrado — rode npm install';
          this.log(`  ${icon} ${pluginName} ${detail}`);
        }
      }
    }

    const requiredFailed = checks.some(c => c.required && !c.ok);
    const optionalFailed = checks.some(c => !c.required && !c.ok);
    if (requiredFailed || (flags.strict && optionalFailed)) {
      this.exit(1);
    }
  }
}
