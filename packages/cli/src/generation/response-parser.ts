import chalk from 'chalk';
import { AIGeneratedResponse } from '@iacmp/ai';

// Arquivos gerenciados pelo projeto/bootstrap — a IA nunca deve gerá-los.
// Quando a IA os reescreve (ex: package.json), clobbera o link do @iacmp/core e
// remove ts-node/typescript — e o synth para de carregar as stacks.
export const PROTECTED_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'iacmp.json', '.env', '.gitignore']);

// Descarta os arquivos protegidos da resposta antes de escrever (mutação in-place).
export function stripProtectedFiles(parsed: AIGeneratedResponse): void {
  const dropped = parsed.files.filter(f => PROTECTED_FILES.has(f.path.split('/').pop() ?? ''));
  if (dropped.length > 0) {
    parsed.files = parsed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop() ?? ''));
    console.log(chalk.dim(`  (ignorando ${dropped.map(f => f.path).join(', ')} — gerenciados pelo projeto, não pela IA)`));
  }
}

// Faz o merge por path da resposta revisada sobre a original: a revisão
// sobrescreve/adiciona, mas arquivos da geração original que a revisão NÃO
// mencionou são MANTIDOS — senão uma revisão que devolve menos arquivos apagaria
// stacks (ex: dropar a api-gateway-stack e deixar as Lambdas sem entrada HTTP).
export function mergeReviewedFiles(original: AIGeneratedResponse['files'], reviewed: AIGeneratedResponse['files']): AIGeneratedResponse['files'] {
  const byPath = new Map(original.map(f => [f.path, f]));
  for (const f of reviewed) byPath.set(f.path, f);
  return [...byPath.values()];
}
