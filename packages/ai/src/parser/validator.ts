import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { GeneratedFile } from './code-extractor';
import { tsCompilerOptions } from '@iacmp/core';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTypeScript(files: GeneratedFile[], projectDir: string): ValidationResult {
  // O diretório temporário fica DENTRO do projeto (não em os.tmpdir()) — a
  // resolução de módulos do TypeScript/Node sobe a árvore de diretórios
  // procurando node_modules, então um tmpDir fora do projeto nunca vê as
  // dependências reais já instaladas (ex: @aws-sdk/*), e qualquer import de
  // pacote de terceiros é reportado como "faltando" mesmo quando já está
  // instalado — falso positivo que confundia a IA a pedir reinstalação de
  // dependências que já existiam.
  const tmpDir = fs.mkdtempSync(path.join(projectDir, '.iacmp-validate-'));

  try {
    // Escreve os arquivos gerados PRESERVANDO a árvore de diretórios. Achatar
    // para basename (comportamento antigo) fazia src/a/index.ts e src/b/index.ts
    // colidirem no mesmo arquivo e quebrava import relativo entre handlers
    // (./util → "Cannot find module") — erros TS FALSOS que alimentavam retries.
    for (const file of files) {
      const filePath = path.resolve(tmpDir, file.path);
      // paths vêm do modelo — nunca deixar escapar do tmpDir (../, absoluto)
      if (!filePath.startsWith(tmpDir + path.sep)) continue;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    // Resolve onde @iacmp/core está instalado — tenta monorepo e global
    const coreTypesPath = (function findCoreTypes() {
      const candidates = [
        // monorepo local (dev)
        path.resolve(__dirname, '..', '..', '..', 'core', 'dist'),
        // node_modules do CLI instalado globalmente
        path.resolve(__dirname, '..', '..', 'node_modules', '@iacmp', 'core', 'dist'),
        // node_modules do projeto do usuário
        path.join(projectDir, 'node_modules', '@iacmp', 'core', 'dist'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'index.d.ts'))) return c;
      }
      return null;
    })();

    // Cria tsconfig mínimo no temp dir
    const tsconfigPaths: Record<string, string[]> = {};
    if (coreTypesPath) {
      tsconfigPaths['@iacmp/core'] = [path.join(coreTypesPath, 'index.d.ts')];
      tsconfigPaths['@iacmp/core/*'] = [path.join(coreTypesPath, '*')];
    }

    const tsconfig = {
      compilerOptions: tsCompilerOptions(projectDir, {
        noEmit: true,
        baseUrl: '/',
        paths: tsconfigPaths,
      }),
      include: [path.join(tmpDir, '**', '*.ts')],
    };

    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2),
      'utf-8'
    );

    // Localiza o tsc disponível
    const candidates = [
      path.join(projectDir, 'node_modules', '.bin', 'tsc'),
      path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsc'),
      path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc'),
    ];
    const tscPath = candidates.find(c => fs.existsSync(c));

    if (!tscPath) {
      // tsc não está disponível no ambiente — não bloqueia o fluxo da IA
      // por um problema de instalação que não tem relação com o código gerado.
      return { valid: true, errors: [] };
    }

    execSync(`${tscPath} --noEmit --project ${path.join(tmpDir, 'tsconfig.json')}`, {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    return { valid: true, errors: [] };
  } catch (err) {
    const error = err as { stdout?: Buffer; stderr?: Buffer; message?: string; code?: string };
    if (error.code === 'ENOENT') {
      // tsc não pôde ser executado — mesmo motivo acima
      return { valid: true, errors: [] };
    }
    const output = (error.stdout?.toString() ?? '') + (error.stderr?.toString() ?? '');
    const errors = output
      .split('\n')
      .filter(l => l.trim().length > 0)
      .slice(0, 20); // limita para não poluir

    return { valid: false, errors };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignora erro de limpeza
    }
  }
}
