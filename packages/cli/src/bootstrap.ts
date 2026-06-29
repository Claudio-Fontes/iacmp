import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Bootstrap automático de projeto para o fluxo `iacmp ai` numa pasta vazia.
 *
 * O usuário típico do `iacmp ai` não roda `iacmp init` antes — abre uma pasta
 * limpa, põe um `.env` com a chave da IA e chama `iacmp ai`. Sem os arquivos de
 * projeto (iacmp.json, tsconfig) e sem `@iacmp/core`/`ts-node` instalados, o
 * loop de validação `iacmp synth` falha com "Projeto não inicializado" e a
 * geração nunca fecha. Esta função cria o mínimo necessário, de forma idempotente
 * e silenciosa, para que esse fluxo funcione de ponta a ponta.
 */

export interface BootstrapResult {
  /** true se algo foi criado/instalado; false se o projeto já estava pronto. */
  bootstrapped: boolean;
  /** itens criados/instalados, para log opcional. */
  created: string[];
}

export interface BootstrapOptions {
  /** Provider gravado no iacmp.json (default: aws). */
  provider?: string;
  /** Instala @iacmp/core + ts-node via npm (default: true). Testes passam false. */
  installDeps?: boolean;
}

export function ensureProjectInitialized(cwd: string, options: BootstrapOptions | string = {}): BootstrapResult {
  // compat: aceita string (provider) ou objeto de opções
  const opts: BootstrapOptions = typeof options === 'string' ? { provider: options } : options;
  const provider = opts.provider ?? 'aws';
  const installDeps = opts.installDeps ?? true;

  const created: string[] = [];
  const configPath = path.join(cwd, 'iacmp.json');

  // Projeto já inicializado → no-op (respeita configuração existente).
  const hasConfig = fs.existsSync(configPath);
  const hasCore = fs.existsSync(path.join(cwd, 'node_modules', '@iacmp', 'core'));
  if (hasConfig && hasCore) {
    return { bootstrapped: false, created };
  }

  const projectName = sanitizeName(path.basename(cwd));

  // 1. iacmp.json — accountTier free é o default seguro; o usuário muda para
  //    standard editando o arquivo quando a conta suportar (RDS cripto/backup).
  if (!hasConfig) {
    const config = {
      name: projectName,
      provider,
      region: 'us-east-1',
      language: 'typescript',
      accountTier: 'free',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    created.push('iacmp.json');
  }

  // 2. tsconfig.json — só src/ (handlers de Lambda) compila para dist/; stacks/
  //    é carregada via ts-node por synth/deploy, não por tsc.
  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(tsconfigPath, tsconfigContent());
    created.push('tsconfig.json');
  }

  // 3. package.json — npm install já cria um se ausente, mas garantimos um
  //    coerente (nome do projeto, scripts úteis) antes de instalar deps.
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, packageJsonContent(projectName));
    created.push('package.json');
  }

  // 4. .gitignore — evita commitar node_modules/.env/dist por acidente.
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignoreContent());
    created.push('.gitignore');
  }

  // 5. deps necessárias para o synth carregar as stacks (.ts via ts-node) e
  //    compilar os handlers. Instala só se @iacmp/core ainda não está presente.
  if (!hasCore && installDeps) {
    // Sem pin de versão: o `iacmp synth` detecta a versão do TypeScript instalada
    // e adapta seus compilerOptions (ts-node), então qualquer TS >= 5 funciona.
    // O npm resolve as versões compatíveis de cada pacote pelo engines/peerDeps.
    execSync('npm install @iacmp/core ts-node typescript @types/node', {
      cwd,
      stdio: 'pipe',
    });
    created.push('deps: @iacmp/core, ts-node, typescript, @types/node');
  }

  return { bootstrapped: true, created };
}

function sanitizeName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'iacmp-project';
}

function tsconfigContent(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        lib: ['es2022'],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        strictPropertyInitialization: false,
        experimentalDecorators: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ) + '\n';
}

function packageJsonContent(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      scripts: {
        build: 'tsc',
        synth: 'iacmp synth',
        deploy: 'iacmp deploy',
      },
    },
    null,
    2,
  ) + '\n';
}

function gitignoreContent(): string {
  return ['node_modules/', 'dist/', 'synth-out/', 'audit/', '.env', '.iacmp/', '.iacmp-validate-*/', '.DS_Store'].join('\n') + '\n';
}
