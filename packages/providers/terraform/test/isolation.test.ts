/**
 * Trava de isolamento de arquitetura — Terraform (camada de formato).
 *
 * O Terraform não é um provider de nuvem: é a camada que serializa em .tf.json
 * o que outro provider já resolveu. Hoje ele importa o emissor de
 * `@iacmp/provider-aws` — uma EXCEÇÃO conhecida e uma dívida (docs/roadmap-fase2.md
 * T2: extrair a serialização para um pacote neutro e remover este import).
 *
 * Esta trava CONGELA a exceção: `@iacmp/core` e `@iacmp/provider-aws` são o
 * único acoplamento tolerado. Qualquer outro import @iacmp (ex.: provider-azure,
 * provider-gcp) faz o teste falhar — a dívida pode ser paga (T2), nunca crescer.
 */
import * as fs from 'fs';
import * as path from 'path';

// core = abstração; provider-aws = exceção conhecida (dívida do T2, a remover).
const PACOTES_IACMP_PERMITIDOS = new Set(['@iacmp/core', '@iacmp/provider-aws']);

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

describe('isolamento de arquitetura — Terraform (formato)', () => {
  const srcDir = path.join(__dirname, '..', 'src');

  it('importa só @iacmp/core e @iacmp/provider-aws (exceção congelada, não pode crescer)', () => {
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
