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
    const config: Record<string, unknown> = {
      name: projectName,
      provider,
      region: 'us-east-1',
      // DR opcional "comentado": JSON não tem comentário — chaves com _ são
      // ignoradas pela ferramenta; renomear (tirar o _) ativa o recurso.
      _drRegion: 'us-west-2 (DR na AWS — renomeie para drRegion para ativar)',
      language: 'typescript',
      accountTier: 'free',
    };
    if (provider === 'azure') {
      config['resourceGroup'] = `${projectName}-rg`;
      config['azureRegion'] = 'eastus2';
      config['_azureDrRegion'] = 'centralus (DR na Azure — renomeie para azureDrRegion; RA-GRS usa o par fixo da região)';
    }
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
    // Usa o MESMO @iacmp/core que este CLI resolve. Em um checkout de dev do
    // monorepo, isso é o core local (mais novo que o publicado), evitando que o
    // projeto baixe uma versão defasada do npm e o synth rejeite engines/recursos
    // que o CLI atual já suporta. Em produção (npm -g), resolve o core publicado.
    const coreSpec = resolveCoreInstallSpec();
    // tsx como runtime de TypeScript (suporta TS5–7+, sem registrar ts-node).
    // typescript sem pin — o tsconfig gerado usa moduleResolution:bundler que é
    // válido para qualquer versão suportada. @types/node necessário com bundler.
    execSync(`npm install ${coreSpec} tsx typescript @types/node`, {
      cwd,
      stdio: 'pipe',
    });
    created.push(`deps: @iacmp/core${coreSpec.startsWith('@') ? '' : ' (local)'}, tsx, typescript, @types/node`);
  }

  // .claude/ — CLAUDE.md com instruções para uso via Claude Code
  const claudeDir = path.join(cwd, '.claude');
  if (!fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), bootstrapClaudeMd(projectName));
    created.push('.claude/CLAUDE.md');
  }
  if (!fs.existsSync(path.join(claudeDir, 'settings.local.json'))) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), bootstrapClaudeSettings(cwd));
    created.push('.claude/settings.local.json');
  }

  return { bootstrapped: true, created };
}

function bootstrapClaudeMd(projectName: string): string {
  return `# iacmp — ${projectName}

Este projeto usa o **iacmp CLI** para gerar infraestrutura como código (CloudFormation, Bicep, Terraform) a partir de stacks TypeScript.

## Ferramentas MCP disponíveis

Você tem acesso às ferramentas do servidor \`iacmp\` (MCP). Use-as nesta ordem:

1. \`search_examples\` — busca exemplos validados antes de gerar qualquer stack
2. \`write_stack\` — escreve arquivos TypeScript de stack no projeto
3. \`synth_project\` — roda \`iacmp synth\` e valida os templates gerados
4. \`read_synth_output\` — inspeciona os templates gerados (CloudFormation/Bicep/tf.json)
5. \`deploy_project\` — faz deploy (só quando o usuário pedir explicitamente)
6. \`destroy_project\` — destrói (só quando o usuário pedir explicitamente)

## Organização de stacks (OBRIGATÓRIO)

Cada camada fica em sua própria subpasta dentro de \`stacks/\`:

| Pasta | Constructs |
|---|---|
| \`stacks/compute/\` | \`Compute.*\`, \`Fn.Lambda\` |
| \`stacks/database/\` | \`Database.*\`, \`Cache.*\` |
| \`stacks/storage/\` | \`Storage.*\` |
| \`stacks/network/\` | \`Network.*\`, \`Fn.ApiGateway\` |
| \`stacks/messaging/\` | \`Messaging.*\`, \`Events.*\` |
| \`stacks/policy/\` | \`Policy.IAM\` |
| \`stacks/security/\` | \`Secret.*\`, \`Certificate.*\` |
| \`stacks/monitoring/\` | \`Monitoring.*\`, \`Logging.*\` |
| \`stacks/workflow/\` | \`Workflow.*\` |

## Regras de código

- Import único permitido: \`import { Stack, ... } from '@iacmp/core';\`
- Inclua \`ref\` no import se usar \`ref()\`: \`import { Stack, Fn, ref } from '@iacmp/core';\`
- Sempre exporte a stack como default: \`export default stack;\`
- Nomes derivados do domínio do usuário — nunca copie nomes de exemplo
- Não invente propriedades que não existem no catálogo do @iacmp/core

## Referências cross-stack

**Padrão preferido — export tipado:**
\`\`\`typescript
// stacks/database/usuarios-table-stack.ts
export const table = new Database.DynamoDB(stack, 'UsuariosTable', { ... });

// stacks/compute/usuarios-lambda-stack.ts
import { table } from '../database/usuarios-table-stack';
environment: { TABLE_NAME: table.name }
// Policy.IAM:
resources: [table.arn]
\`\`\`

**Alternativa com ref() — quando não há import entre stacks:**
\`\`\`typescript
environment: { TABLE_NAME: ref('UsuariosTable', 'Name') }
resources:   [ref('UsuariosTable', 'Arn')]
\`\`\`

- \`ref()\` retorna um objeto interno — NUNCA chame \`.toString()\` nele
- \`environment\` com recurso: SEMPRE \`ref()\` ou \`table.name\` — nunca string literal

## Fluxo de trabalho (OBRIGATÓRIO — siga sempre esta ordem)

1. Chame \`search_examples\` com palavras-chave do que o usuário quer
2. Gere TODAS as stacks necessárias e chame \`write_stack\` para cada uma
3. **SEMPRE chame \`synth_project\` após escrever as stacks** — nunca entregue resultado sem validar
4. Se o synth retornar erro: leia a mensagem, corrija os arquivos com \`write_stack\` e repita o synth
5. Repita o loop (correção → synth) até o synth passar sem erros
6. Só após synth verde: mostre ao usuário o resultado e os próximos passos

O synth não é opcional. Entregar stacks sem synth verde é o mesmo que entregar código que não compila.

## Restrições

- NUNCA modifique \`package.json\`, \`tsconfig.json\`, \`.env\` ou \`iacmp.json\`
- NUNCA use aws-cdk-lib, constructs ou qualquer pacote fora do @iacmp/core
- NUNCA deixe código incompleto (sem \`// TODO\` ou placeholders)
- Deploy e destroy: só quando o usuário pedir explicitamente
`;
}

function bootstrapClaudeSettings(cwd: string): string {
  const coreDir = (() => {
    try {
      const corePkgJson = require.resolve('@iacmp/core/package.json');
      return path.dirname(corePkgJson);
    } catch {
      return path.join(cwd, 'node_modules', '@iacmp', 'core');
    }
  })();
  return JSON.stringify({
    permissions: {
      allow: [
        `Read(${coreDir}/src/**)`,
        `Read(${coreDir}/dist/**)`,
        'Bash(npm run *)',
        'Bash(iacmp *)',
        'Bash(npx iacmp *)',
      ],
    },
  }, null, 2) + '\n';
}

/**
 * Decide o que passar para `npm install` no lugar de `@iacmp/core`:
 * - checkout de dev do monorepo → o caminho do core local (instala como file:),
 *   garantindo que o projeto use a MESMA versão que o CLI atual;
 * - instalação normal (npm) → o nome do pacote, resolvido do registry.
 *
 * A heurística de "dev" é a presença de `src/` ao lado do package.json do core
 * que este CLI resolve — pacotes publicados só trazem `dist/`.
 */
export function resolveCoreInstallSpec(): string {
  try {
    const corePkgJson = require.resolve('@iacmp/core/package.json');
    const coreDir = path.dirname(corePkgJson);
    if (fs.existsSync(path.join(coreDir, 'src'))) {
      return coreDir; // npm install <path> → "@iacmp/core": "file:<path>"
    }
  } catch {
    // @iacmp/core não resolível a partir do CLI — cai no registry.
  }
  return '@iacmp/core';
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
        moduleResolution: 'bundler',
        lib: ['es2022'],
        types: ['node'],
        // Leniente de propósito: os handlers em src/ são gerados pela IA e
        // importam libs (pg, ioredis, aws-sdk...) que nem sempre têm @types
        // instalados. Strict aqui bloquearia o build por "implicit any" mesmo
        // com o JS de saída perfeitamente válido para o Lambda. O que importa é
        // emitir dist/*.js correto, não type-check rigoroso de código gerado.
        strict: false,
        noImplicitAny: false,
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
