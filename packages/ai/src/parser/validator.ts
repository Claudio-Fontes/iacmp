import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GeneratedFile } from './code-extractor';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTypeScript(files: GeneratedFile[], projectDir: string): ValidationResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-validate-'));

  try {
    // Escreve os arquivos gerados no diretório temporário
    for (const file of files) {
      const filePath = path.join(tmpDir, path.basename(file.path));
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    // Cria tsconfig mínimo no temp dir
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: false,
        skipLibCheck: true,
        noEmit: true,
        baseUrl: projectDir,
        paths: {
          '@iacmp/core': [path.join(projectDir, 'node_modules', '@iacmp', 'core', 'dist', 'index.d.ts')],
        },
      },
      include: [path.join(tmpDir, '*.ts')],
    };

    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2),
      'utf-8'
    );

    // Localiza o tsc disponível
    let tscPath = 'tsc';
    const localTsc = path.join(projectDir, 'node_modules', '.bin', 'tsc');
    if (fs.existsSync(localTsc)) {
      tscPath = localTsc;
    }

    execSync(`${tscPath} --noEmit --project ${path.join(tmpDir, 'tsconfig.json')}`, {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    return { valid: true, errors: [] };
  } catch (err) {
    const error = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
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
