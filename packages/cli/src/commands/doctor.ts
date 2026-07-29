import { Command, Flags } from '@oclif/core';
import { execFileSync, execSync } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { t } from '../i18n';
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
  if (!out) return { label: 'Node.js', ok: false, required: true, hint: t('Instale em: https://nodejs.org', 'Install at: https://nodejs.org') };
  const version = out.replace('v', '');
  const major = parseInt(version.split('.')[0], 10);
  return {
    label: 'Node.js',
    ok: major >= 20,
    required: true,
    value: out,
    hint: major < 20 ? t('Node.js 20+ é necessário.', 'Node.js 20+ is required.') : undefined,
  };
}

function checkNpm(): Check {
  const out = tryExec('npm --version');
  if (!out) return { label: 'npm', ok: false, required: true, hint: t('Instale Node.js (npm vem junto).', 'Install Node.js (npm comes with it).') };
  return { label: 'npm', ok: true, required: true, value: `v${out}` };
}

function checkIacmp(): Check {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  try {
    const pkg = readJsonFile<{ version: string }>(pkgPath);
    return { label: 'iacmp', ok: true, required: false, value: `v${pkg.version}` };
  } catch {
    return { label: 'iacmp', ok: false, required: false, hint: t('package.json não encontrado', 'package.json not found') };
  }
}

function awsCliHint(): string {
  switch (process.platform) {
    case 'darwin':
      return t('Instale com: brew install awscli (ou rode: iacmp doctor --fix)', 'Install with: brew install awscli (or run: iacmp doctor --fix)');
    case 'linux':
      return t('Instale com: sudo apt-get install awscli — ou baixe em https://aws.amazon.com/cli/', 'Install with: sudo apt-get install awscli — or download at https://aws.amazon.com/cli/');
    case 'win32':
      return t('Instale com: winget install -e --id Amazon.AWSCLI (ou choco install awscli) — ou baixe em https://aws.amazon.com/cli/', 'Install with: winget install -e --id Amazon.AWSCLI (or choco install awscli) — or download at https://aws.amazon.com/cli/');
    default:
      return t('Instale o AWS CLI: https://aws.amazon.com/cli/', 'Install the AWS CLI: https://aws.amazon.com/cli/');
  }
}

function checkAwsCli(): Check {
  const out = tryExec('aws --version');
  if (!out) {
    return {
      label: 'AWS CLI',
      ok: false,
      required: false,
      hint: awsCliHint(),
      fix: fixViaPackageManager({ brew: 'awscli', aptGet: 'awscli', winget: 'Amazon.AWSCLI', choco: 'awscli' }),
    };
  }
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

function azureCliHint(): string {
  switch (process.platform) {
    case 'darwin':
      return t('Necessário para --provider azure — instale com: brew install azure-cli (ou rode: iacmp doctor --fix)', 'Required for --provider azure — install with: brew install azure-cli (or run: iacmp doctor --fix)');
    case 'linux':
      return t('Necessário para --provider azure — instale com: sudo apt-get install azure-cli (ou rode: iacmp doctor --fix)', 'Required for --provider azure — install with: sudo apt-get install azure-cli (or run: iacmp doctor --fix)');
    case 'win32':
      return t('Necessário para --provider azure — instale com: winget install -e --id Microsoft.AzureCLI (ou rode: iacmp doctor --fix)', 'Required for --provider azure — install with: winget install -e --id Microsoft.AzureCLI (or run: iacmp doctor --fix)');
    default:
      return t('Necessário para --provider azure — instale em: https://learn.microsoft.com/cli/azure/install-azure-cli', 'Required for --provider azure — install at: https://learn.microsoft.com/cli/azure/install-azure-cli');
  }
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
    hint: azureCliHint(),
    fix: fixViaPackageManager({ brew: 'azure-cli', aptGet: 'azure-cli', winget: 'Microsoft.AzureCLI' }),
  };
}

function gcloudHint(): string {
  switch (process.platform) {
    case 'darwin':
      return t('Necessário para --provider gcp — instale com: brew install --cask google-cloud-sdk (ou rode: iacmp doctor --fix)', 'Required for --provider gcp — install with: brew install --cask google-cloud-sdk (or run: iacmp doctor --fix)');
    case 'linux':
      return t('Necessário para --provider gcp — instale seguindo: https://cloud.google.com/sdk/docs/install', 'Required for --provider gcp — install following: https://cloud.google.com/sdk/docs/install');
    case 'win32':
      return t('Necessário para --provider gcp — instale com: winget install -e --id Google.CloudSDK (ou rode: iacmp doctor --fix)', 'Required for --provider gcp — install with: winget install -e --id Google.CloudSDK (or run: iacmp doctor --fix)');
    default:
      return t('Necessário para --provider gcp — instale em: https://cloud.google.com/sdk/docs/install', 'Required for --provider gcp — install at: https://cloud.google.com/sdk/docs/install');
  }
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
    hint: gcloudHint(),
    fix: fixViaPackageManager({ brewCask: 'google-cloud-sdk', winget: 'Google.CloudSDK' }),
  };
}

function terraformHint(): string {
  switch (process.platform) {
    case 'darwin':
      return t('Necessário para --provider terraform — instale com: brew install terraform (ou rode: iacmp doctor --fix)', 'Required for --provider terraform — install with: brew install terraform (or run: iacmp doctor --fix)');
    case 'linux':
      return t('Necessário para --provider terraform — instale com: sudo apt-get install terraform (ou rode: iacmp doctor --fix)', 'Required for --provider terraform — install with: sudo apt-get install terraform (or run: iacmp doctor --fix)');
    case 'win32':
      return t('Necessário para --provider terraform — instale com: winget install -e --id Hashicorp.Terraform (ou choco install terraform) — ou rode: iacmp doctor --fix', 'Required for --provider terraform — install with: winget install -e --id Hashicorp.Terraform (or choco install terraform) — or run: iacmp doctor --fix');
    default:
      return t('Necessário para --provider terraform — instale em: https://developer.hashicorp.com/terraform/install', 'Required for --provider terraform — install at: https://developer.hashicorp.com/terraform/install');
  }
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
    hint: terraformHint(),
    fix: fixViaPackageManager({ brew: 'terraform', aptGet: 'terraform', winget: 'Hashicorp.Terraform', choco: 'terraform' }),
  };
}

function checkAnthropicKey(): Check {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    label: 'ANTHROPIC_API_KEY',
    ok: true,
    required: false,
    value: key ? t('configurado', 'configured') : t('não configurado (necessário para iacmp ai)', 'not configured (required for iacmp ai)'),
  };
}

function checkAwsIamPermissions(): Check {
  const label = 'AWS IAM permissions (lambda, apigateway)';
  const identity = tryExec('aws sts get-caller-identity');
  if (!identity) {
    return { label, ok: false, required: false, hint: t('Credenciais AWS não encontradas. Configure com: aws configure', 'AWS credentials not found. Configure with: aws configure') };
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
    hint: t(`Permissões faltando: ${missing.join(', ')}. Adicione à policy IAM do usuário — veja docs/iam-policy.json`, `Missing permissions: ${missing.join(', ')}. Add them to the user's IAM policy — see docs/iam-policy.json`),
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
      return t('Instale com: brew install sox (ou rode: iacmp doctor --fix)', 'Install with: brew install sox (or run: iacmp doctor --fix)');
    case 'linux':
      return t('Instale com: sudo apt-get install -y sox (ou equivalente da sua distro) — ou rode: iacmp doctor --fix', 'Install with: sudo apt-get install -y sox (or your distro\'s equivalent) — or run: iacmp doctor --fix');
    case 'win32':
      return t('Instale com: winget install -e --id ChrisBagwell.SoX (ou choco install sox) — ou rode: iacmp doctor --fix', 'Install with: winget install -e --id ChrisBagwell.SoX (or choco install sox) — or run: iacmp doctor --fix');
    default:
      return t('Instale o sox manualmente — necessário para o comando /voz do chat.', 'Install sox manually — required for the chat /voz command.');
  }
}

function checkSox(): Check {
  if (commandExists('sox')) {
    const out = tryExec('sox --version');
    return { label: 'sox', ok: true, required: false, value: out ?? t('instalado', 'installed') };
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
    return t('Instale com: brew install whisper-cpp (ou rode: iacmp doctor --fix)', 'Install with: brew install whisper-cpp (or run: iacmp doctor --fix)');
  }
  return t('Sem instalação automática nesta plataforma — baixe um binário em https://github.com/ggerganov/whisper.cpp/releases ou compile localmente, e configure IACMP_WHISPER_BIN.', 'No automatic install on this platform — download a binary at https://github.com/ggerganov/whisper.cpp/releases or build locally, and set IACMP_WHISPER_BIN.');
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
    return { label: t('modelo whisper (ggml)', 'whisper model (ggml)'), ok: true, required: false, value: modelPath };
  }
  return {
    label: t('modelo whisper (ggml)', 'whisper model (ggml)'),
    ok: false,
    required: false,
    hint: t('Necessário para o comando /voz — rode: iacmp doctor --fix para baixar um modelo padrão (~148MB) e configurar IACMP_WHISPER_MODEL', 'Required for the /voz command — run: iacmp doctor --fix to download a default model (~148MB) and set IACMP_WHISPER_MODEL'),
    fix: {
      description: t('baixar modelo ggml-base (~148MB) e configurar IACMP_WHISPER_MODEL no .env', 'download the ggml-base model (~148MB) and set IACMP_WHISPER_MODEL in .env'),
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
  static description = t('Verifica o ambiente e dependências do iacmp', 'Checks the iacmp environment and dependencies');

  static examples = [
    '$ iacmp doctor',
    '$ iacmp doctor --strict',
    '$ iacmp doctor --fix',
  ];

  static flags = {
    strict: Flags.boolean({
      description: t('Falha (exit 1) também para checagens opcionais (AWS CLI, etc.)', 'Fails (exit 1) for optional checks too (AWS CLI, etc.)'),
      default: false,
    }),
    fix: Flags.boolean({
      description: t('Tenta corrigir itens ausentes com instalação conhecida (sox, whisper.cpp, modelo), pedindo confirmação antes de cada ação.', 'Tries to fix missing items with a known install (sox, whisper.cpp, model), asking for confirmation before each action.'),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const cwd = process.cwd();
    this.log(t('Verificando ambiente...\n', 'Checking environment...\n'));

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
        this.log(t(`  ${icon} ${check.label} nao encontrado`, `  ${icon} ${check.label} not found`));
        if (check.hint) {
          this.log(`      ${check.hint}`);
        }
      }
    }

    this.log('');
    if (checks.every(c => c.ok)) {
      this.log(t('Ambiente OK. Pronto para uso.', 'Environment OK. Ready to use.'));
    } else {
      this.log(t('Alguns itens precisam de atenção.', 'Some items need attention.'));
    }

    if (flags.fix) {
      const fixableCount = checks.filter(c => !c.ok && c.fix).length;
      if (fixableCount === 0) {
        this.log(t('\nNada para corrigir automaticamente nesta plataforma.', '\nNothing to fix automatically on this platform.'));
      } else {
        this.log(t('\nCorrigindo...', '\nFixing...'));
        const asker = createAsker();
        for (let i = 0; i < checks.length; i++) {
          const check = checks[i];
          if (check.ok || !check.fix) continue;

          const proceed = await confirm(asker, t(`\n${check.label}: executar "${check.fix.description}"?`, `\n${check.label}: run "${check.fix.description}"?`));
          if (!proceed) {
            this.log(t('  pulado.', '  skipped.'));
            continue;
          }

          try {
            await check.fix.run();
            const updated = makeChecks()[i];
            checks[i] = updated;
            this.log(updated.ok ? t(`  ✓ ${updated.label} corrigido`, `  ✓ ${updated.label} fixed`) : t(`  ✗ ainda nao encontrado apos a instalacao`, `  ✗ still not found after the install`));
          } catch (err) {
            this.log(t(`  ✗ falhou: ${err instanceof Error ? err.message : String(err)}`, `  ✗ failed: ${err instanceof Error ? err.message : String(err)}`));
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
        this.log(t('\nPlugins do projeto:', '\nProject plugins:'));

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
            : t('não encontrado — rode npm install', 'not found — run npm install');
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
