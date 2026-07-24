/**
 * Trava de isolamento de arquitetura — GCP.
 *
 * Garante que o provider GCP depende SOMENTE da abstração (`@iacmp/core`).
 *
 * Isto protege o trabalho da Fase 1 (docs/roadmap-fase2.md §4, G1): ao ganhar a
 * pasta `constructs/`, o GCP será muito mexido. O maior risco é ele tentar
 * reusar o emissor Terraform, que hoje mora DENTRO de `@iacmp/provider-aws` —
 * isso acoplaria GCP↔AWS. Esta trava força a rota correta (T1: extrair a camada
 * de formato .tf.json por cópia) em vez do atalho que quebra o isolamento.
 *
 * Se falhar, remova o import — não relaxe a regra.
 */
import * as fs from 'fs';
import * as path from 'path';

const PACOTES_IACMP_PERMITIDOS = new Set(['@iacmp/core']);

function arquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...arquivosTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsIacmp(conteudo: string): string[] {
  const re = /from\s+['"](@iacmp\/[a-z0-9-]+)['"]/g;
  const achados: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(conteudo)) !== null) achados.push(m[1]);
  return achados;
}

describe('isolamento de arquitetura — provider GCP', () => {
  const srcDir = path.join(__dirname, '..', 'src');

  it('só importa @iacmp/core (não pode acoplar ao AWS via emissor Terraform)', () => {
    const violacoes: string[] = [];
    for (const arquivo of arquivosTs(srcDir)) {
      const conteudo = fs.readFileSync(arquivo, 'utf8');
      for (const pkg of importsIacmp(conteudo)) {
        if (!PACOTES_IACMP_PERMITIDOS.has(pkg)) {
          violacoes.push(`${path.relative(srcDir, arquivo)} → ${pkg}`);
        }
      }
    }
    expect(violacoes).toEqual([]);
  });
});
