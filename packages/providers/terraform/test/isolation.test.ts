/**
 * Trava de isolamento de arquitetura — matriz completa dos providers.
 *
 * Fica AQUI (no pacote terraform, camada de formato da fase GCP/Terraform) de
 * propósito: `providers/aws` e `providers/azure` não podem receber NADA novo —
 * nem um teste. Este teste lê o `src/` dos quatro providers via filesystem e
 * falha se qualquer um importar um pacote `@iacmp/*` fora do permitido.
 *
 * Enquanto passar, nenhum trabalho em GCP/Terraform tem como alcançar o synth de
 * AWS (CloudFormation) ou Azure (Bicep) — não existe a aresta de dependência.
 * Ver docs/roadmap-fase2.md §0. Import proibido → remova-o, não relaxe a regra.
 */
import * as fs from 'fs';
import * as path from 'path';

// AWS e Azure: só a abstração. GCP: só a abstração (não pode reusar o emissor
// Terraform que vive no aws). Terraform: core + provider-aws (exceção conhecida
// e congelada — a dívida do T2 pode ser paga, nunca crescer).
const MATRIX: Array<{ pkg: string; src: string; allowed: string[] }> = [
  { pkg: 'aws', src: '../../aws/src', allowed: ['@iacmp/core'] },
  { pkg: 'azure', src: '../../azure/src', allowed: ['@iacmp/core'] },
  { pkg: 'gcp', src: '../../gcp/src', allowed: ['@iacmp/core'] },
  { pkg: 'terraform', src: '../src', allowed: ['@iacmp/core', '@iacmp/provider-aws'] },
];

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

describe('isolamento de arquitetura — matriz dos providers', () => {
  for (const { pkg, src, allowed } of MATRIX) {
    it(`${pkg} importa só ${allowed.join(' + ')}`, () => {
      const srcDir = path.join(__dirname, src);
      const permitidos = new Set(allowed);
      const violacoes: string[] = [];
      for (const arquivo of arquivosTs(srcDir)) {
        const conteudo = fs.readFileSync(arquivo, 'utf8');
        for (const p of importsIacmp(conteudo)) {
          if (!permitidos.has(p)) violacoes.push(`${pkg}/${path.relative(srcDir, arquivo)} → ${p}`);
        }
      }
      expect(violacoes).toEqual([]);
    });
  }
});
