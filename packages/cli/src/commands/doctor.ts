import { Command, Flags } from '@oclif/core';
import { execFileSync, execSync } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { readJsonFile } from '../utils';
import { downloadDefaultWhisperModel } from '../utils/whisper-setup';

interface Fix {
  description: string;
  run: () => Promise<void>;
}

interface Check {
  label: string;
  ok: boolean;
  /** required=true => falha derruba o exit code mesmo sem --strict. */
  required: boolean;
  value?: string;
  hint?: string;
  fix?: Fix;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

/** Existência de um binário no PATH, cross-platform (where no Windows, which no resto). */
export function commandExists(bin: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [bin], { stdio: 'pipe' }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
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

// --- iacmp deploy/destroy: CLIs nativas dos demais providers ---

function fixViaPackageManager(opts: {
  brew?: string;
  brewCask?: string;
  aptGet?: string;
  winget?: string;
  choco?: string;
}): Fix | undefined {
  if (process.platform === 'darwin' && commandExists('brew')) {
    if (opts.brewCask) {
      return {
        description: `brew install --cask ${opts.brewCask}`,
        run: async () => { execSync(`brew install --cask ${opts.brewCask}`, { stdio: 'inherit' }); },
      };
    }
    if (opts.brew) {
      return { description: `brew install ${opts.brew}`, run: async () => { execSync(`brew install ${opts.brew}`, { stdio: 'inherit' }); } };
    }
  }
  if (process.platform === 'linux' && opts.aptGet && commandExists('apt-get')) {
    return {
      description: `sudo apt-get install -y ${opts.aptGet}`,
      run: async () => { execSync(`sudo apt-get install -y ${opts.aptGet}`, { stdio: 'inherit' }); },
    };
  }
  if (process.platform === 'win32') {
    if (opts.winget && commandExists('winget')) {
      return {
        description: `winget install -e --id ${opts.winget}`,
        run: async () => {
          execSync(
            `winget install -e --id ${opts.winget} --silent --accept-source-agreements --accept-package-agreements`,
            { stdio: 'inherit' }
          );
        },
      };
    }
    if (opts.choco && commandExists('choco')) {
      return { description: `choco install ${opts.choco} -y`, run: async () => { execSync(`choco install ${opts.choco} -y`, { stdio: 'inherit' }); } };
    }
  }
  return undefined;
}

function checkAzureCli(): Check {
  const out = tryExec('az --version');
  if (out) {
    const version = out.split('\n')[0]?.split(/\s+/).pop() ?? out.split('\n')[0];
    return { label: 'Azure CLI', ok: true, required: false, value: version };
  }
  return {
    label: 'Azure CLI',
    ok: false,
    required: false,
    hint: 'Necessário para iacmp deploy/destroy --provider azure — rode: iacmp doctor --fix',
    fix: fixViaPackageManager({ brew: 'azure-cli', aptGet: 'azure-cli', winget: 'Microsoft.AzureCLI' }),
  };
}

function checkGcloudCli(): Check {
  const out = tryExec('gcloud --version');
  if (out) {
    const version = out.split('\n')[0]?.split(/\s+/).pop() ?? out.split('\n')[0];
    return { label: 'gcloud CLI', ok: true, required: false, value: version };
  }
  return {
    label: 'gcloud CLI',
    ok: false,
    required: false,
    hint: 'Necessário para iacmp deploy/destroy --provider gcp — rode: iacmp doctor --fix (mac) ou instale manualmente em https://cloud.google.com/sdk/docs/install',
    fix: fixViaPackageManager({ brewCask: 'google-cloud-sdk' }),
  };
}

function checkTerraformCli(): Check {
  const out = tryExec('terraform --version');
  if (out) {
    const version = out.split('\n')[0]?.split(/\s+/).pop() ?? out.split('\n')[0];
    return { label: 'Terraform CLI', ok: true, required: false, value: version };
  }
  return {
    label: 'Terraform CLI',
    ok: false,
    required: false,
    hint: 'Necessário para iacmp deploy/destroy --provider terraform — rode: iacmp doctor --fix',
    fix: fixViaPackageManager({ brew: 'terraform', aptGet: 'terraform', winget: 'Hashicorp.Terraform' }),
  };
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

function checkAwsIamPermissions(): Check {
  const label = 'AWS IAM permissions (lambda, apigateway)';
  const identity = tryExec('aws sts get-caller-identity');
  if (!identity) {
    return { label, ok: false, required: false, hint: 'Credenciais AWS não encontradas. Configure com: aws configure' };
  }
  const lambdaOk = tryExec('aws lambda list-functions --max-items 1') !== null;
  const apigwOk = tryExec('aws apigateway get-rest-apis --limit 1') !== null;
  if (lambdaOk && apigwOk) {
    return { label, ok: true, required: false, value: 'OK' };
  }
  const missing: string[] = [];
  if (!lambdaOk) missing.push('lambda:*');
  if (!apigwOk) missing.push('apigateway:*');
  return {
    label,
    ok: false,
    required: false,
    hint: `Permissões faltando: ${missing.join(', ')}. Adicione à policy IAM do usuário — veja docs/iam-policy.json`,
  };
}

// --- Voz no chat (/voz): sox + whisper.cpp + modelo ggml ---

function fixSox(): Fix | undefined {
  if (process.platform === 'darwin' && commandExists('brew')) {
    return { description: 'brew install sox', run: async () => { execSync('brew install sox', { stdio: 'inherit' }); } };
  }
  if (process.platform === 'linux' && commandExists('apt-get')) {
    return {
      description: 'sudo apt-get install -y sox',
      run: async () => { execSync('sudo apt-get install -y sox', { stdio: 'inherit' }); },
    };
  }
  if (process.platform === 'win32') {
    if (commandExists('winget')) {
      return {
        description: 'winget install -e --id ChrisBagwell.SoX',
        run: async () => {
          execSync(
            'winget install -e --id ChrisBagwell.SoX --silent --accept-source-agreements --accept-package-agreements',
            { stdio: 'inherit' }
          );
        },
      };
    }
    if (commandExists('choco')) {
      return { description: 'choco install sox -y', run: async () => { execSync('choco install sox -y', { stdio: 'inherit' }); } };
    }
  }
  return undefined;
}

function soxHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Instale com: brew install sox (ou rode: iacmp doctor --fix)';
    case 'linux':
      return 'Instale com: sudo apt-get install -y sox (ou equivalente da sua distro) — ou rode: iacmp doctor --fix';
    case 'win32':
      return 'Instale com: winget install -e --id ChrisBagwell.SoX (ou choco install sox) — ou rode: iacmp doctor --fix';
    default:
      return 'Instale o sox manualmente — necessário para o comando /voz do chat.';
  }
}

function checkSox(): Check {
  if (commandExists('sox')) {
    const out = tryExec('sox --version');
    return { label: 'sox', ok: true, required: false, value: out ?? 'instalado' };
  }
  return { label: 'sox', ok: false, required: false, hint: soxHint(), fix: fixSox() };
}

function fixWhisperBinary(): Fix | undefined {
  if (process.platform === 'darwin' && commandExists('brew')) {
    return {
      description: 'brew install whisper-cpp',
      run: async () => { execSync('brew install whisper-cpp', { stdio: 'inherit' }); },
    };
  }
  return undefined;
}

function whisperBinaryHint(): string {
  if (process.platform === 'darwin') {
    return 'Instale com: brew install whisper-cpp (ou rode: iacmp doctor --fix)';
  }
  return 'Sem instalação automática nesta plataforma — baixe um binário em https://github.com/ggerganov/whisper.cpp/releases ou compile localmente, e configure IACMP_WHISPER_BIN.';
}

function checkWhisperBinary(): Check {
  const candidates = process.env.IACMP_WHISPER_BIN
    ? [process.env.IACMP_WHISPER_BIN]
    : ['whisper-cli', 'main', 'whisper'];
  for (const candidate of candidates) {
    const found = commandExists(candidate);
    if (found) return { label: 'whisper.cpp', ok: true, required: false, value: found };
  }
  return { label: 'whisper.cpp', ok: false, required: false, hint: whisperBinaryHint(), fix: fixWhisperBinary() };
}

function checkWhisperModel(cwd: string): Check {
  const modelPath = process.env.IACMP_WHISPER_MODEL;
  if (modelPath && fs.existsSync(modelPath)) {
    return { label: 'modelo whisper (ggml)', ok: true, required: false, value: modelPath };
  }
  return {
    label: 'modelo whisper (ggml)',
    ok: false,
    required: false,
    hint: 'Necessário para o comando /voz — rode: iacmp doctor --fix para baixar um modelo padrão (~148MB) e configurar IACMP_WHISPER_MODEL',
    fix: {
      description: 'baixar modelo ggml-base (~148MB) e configurar IACMP_WHISPER_MODEL no .env',
      run: async () => {
        // upsertEnvVar só grava no arquivo .env — o processo atual não relê o
        // .env automaticamente, então sem isso a re-checagem abaixo falharia
        // mesmo com o download/gravação tendo funcionado.
        process.env.IACMP_WHISPER_MODEL = await downloadDefaultWhisperModel(cwd);
      },
    },
  };
}

interface Asker {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

// readline.question() perde perguntas subsequentes quando o stdin é um pipe
// não-interativo (ex: testes, scripts) — todas as linhas chegam de uma vez e
// as que não têm listener ainda anexado no momento se perdem. Usa fila interna
// (mesmo padrão de packages/cli/bin/chat.js) para funcionar em TTY e em pipe.
function createAsker(): Asker {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let done = false;

  rl.on('line', line => {
    const trimmed = line.trim();
    if (waiters.length > 0) waiters.shift()!(trimmed);
    else queue.push(trimmed);
  });
  rl.on('close', () => {
    done = true;
    while (waiters.length > 0) waiters.shift()!('');
  });

  function ask(question: string): Promise<string> {
    process.stdout.write(question);
    return new Promise(resolve => {
      if (queue.length > 0) resolve(queue.shift()!);
      else if (done) resolve('');
      else waiters.push(resolve);
    });
  }

  return { ask, close: () => rl.close() };
}

async function confirm(asker: Asker, question: string): Promise<boolean> {
  const answer = await asker.ask(`${question} [y/N] `);
  return answer.trim().toLowerCase() === 'y';
}

export default class Doctor extends Command {
  static description = 'Verifica o ambiente e dependências do iacmp';

  static examples = [
    '$ iacmp doctor',
    '$ iacmp doctor --strict',
    '$ iacmp doctor --fix',
  ];

  static flags = {
    strict: Flags.boolean({
      description: 'Falha (exit 1) também para checagens opcionais (AWS CLI, etc.)',
      default: false,
    }),
    fix: Flags.boolean({
      description: 'Tenta corrigir itens ausentes com instalação conhecida (sox, whisper.cpp, modelo), pedindo confirmação antes de cada ação.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const cwd = process.cwd();
    this.log('Verificando ambiente...\n');

    const configPath = path.join(cwd, 'iacmp.json');
    let projectProvider: string | undefined;
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { provider?: string };
        projectProvider = cfg.provider;
      } catch {}
    }

    const isAws = !projectProvider || projectProvider === 'aws';

    const makeChecks = (): Check[] => [
      checkNode(),
      checkNpm(),
      checkIacmp(),
      checkAwsCli(),
      ...(isAws ? [checkAwsIamPermissions()] : []),
      checkAzureCli(),
      checkGcloudCli(),
      checkTerraformCli(),
      checkAnthropicKey(),
      checkSox(),
      checkWhisperBinary(),
      checkWhisperModel(cwd),
    ];

    let checks = makeChecks();

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
    if (checks.every(c => c.ok)) {
      this.log('Ambiente OK. Pronto para uso.');
    } else {
      this.log('Alguns itens precisam de atenção.');
    }

    if (flags.fix) {
      const fixableCount = checks.filter(c => !c.ok && c.fix).length;
      if (fixableCount === 0) {
        this.log('\nNada para corrigir automaticamente nesta plataforma.');
      } else {
        this.log('\nCorrigindo...');
        const asker = createAsker();
        for (let i = 0; i < checks.length; i++) {
          const check = checks[i];
          if (check.ok || !check.fix) continue;

          const proceed = await confirm(asker, `\n${check.label}: executar "${check.fix.description}"?`);
          if (!proceed) {
            this.log('  pulado.');
            continue;
          }

          try {
            await check.fix.run();
            const updated = makeChecks()[i];
            checks[i] = updated;
            this.log(updated.ok ? `  ✓ ${updated.label} corrigido` : `  ✗ ainda nao encontrado apos a instalacao`);
          } catch (err) {
            this.log(`  ✗ falhou: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        asker.close();
      }
    }

    // Verifica plugins do projeto atual
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
