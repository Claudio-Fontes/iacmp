import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import ora from 'ora';
import { validateTypeScript } from '@iacmp/ai';
import { GeneratedFile } from './autocorrect';

interface TsResult {
  valid: boolean;
  errors: string[];
}

// Um pacote traz tipos próprios quando declara "types"/"typings" no package.json
// ou expõe um index.d.ts na raiz. Se não, o handler que o importa precisa do
// @types/<pkg> pra passar no tsc do projeto (noImplicitAny).
function hasBundledTypes(cwd: string, mod: string): boolean {
  const modDir = path.join(cwd, 'node_modules', mod);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf-8'));
    if (pkg.types || pkg.typings) return true;
  } catch { /* sem package.json legível */ }
  return fs.existsSync(path.join(modDir, 'index.d.ts'));
}

// Instala módulos "Cannot find module" dos erros TS (com os filtros de SDK do
// Azure) e retorna true se instalou algo. Usado ANTES do loop e DENTRO do loop
// de synth — sem isso, um SDK trocado no meio das correções (ex: data-tables→pg)
// nunca instala e o loop queima todas as rodadas em TS2307 (ciclo p01az7).
export function tryInstallMissingModules(errors: string[], cwd: string, iacProvider: string): boolean {
  const missingModules = errors
    .map(e => e.match(/Cannot find module '([^']+)'/))
    .filter(Boolean)
    .map(m => m![1])
    .filter(pkg => !pkg.startsWith('.') && !pkg.startsWith('@iacmp/'))
    .filter((v, i, a) => a.indexOf(v) === i);
  // @azure/data-tables/@azure/cosmos NUNCA são o SDK certo no Azure (Database.DynamoDB
  // e Database.DocumentDB são ambos Cosmos MongoDB API — driver mongodb). NÃO instalar
  // (mascararia o SDK errado e o detector do loop nunca forçaria a troca).
  const modulesToInstall = iacProvider === 'azure'
    ? missingModules.filter(pkg => !pkg.startsWith('@aws-sdk/') && pkg !== '@azure/data-tables' && pkg !== '@azure/cosmos')
    : missingModules;
  if (modulesToInstall.length === 0) return false;
  const installSpinner = ora({ text: `Instalando dependências: ${modulesToInstall.join(', ')}...`, spinner: 'dots', discardStdin: false }).start();
  try {
    cp.execSync(`npm install ${modulesToInstall.join(' ')}`, { cwd, stdio: 'pipe' });
    const typesPkgs = modulesToInstall
      .filter(m => !m.startsWith('@'))
      .filter(m => !hasBundledTypes(cwd, m))
      .map(m => `@types/${m}`);
    for (const t of typesPkgs) {
      try { cp.execSync(`npm install -D ${t}`, { cwd, stdio: 'pipe' }); } catch { /* sem @types — ignora */ }
    }
    installSpinner.succeed(`Instalado: ${[...modulesToInstall, ...typesPkgs].join(', ')}`);
    return true;
  } catch {
    installSpinner.fail(`Falha ao instalar ${modulesToInstall.join(', ')}`);
    return false;
  }
}

// Valida os arquivos .ts e, se falhar por "Cannot find module", instala os
// pacotes faltantes e revalida uma vez — evita que a IA troque por outra lib
// que também não existe.
export function validateWithAutoInstall(tsFiles: GeneratedFile[], cwd: string, iacProvider: string): TsResult {
  let result = validateTypeScript(tsFiles, cwd);
  if (!result.valid && tryInstallMissingModules(result.errors, cwd, iacProvider)) {
    result = validateTypeScript(tsFiles, cwd);
  }
  return result;
}
