/**
 * Trava de isolamento de arquitetura — Azure.
 *
 * Garante que o provider Azure depende SOMENTE da abstração (`@iacmp/core`) e de
 * nenhum outro provider. Enquanto esta trava passar, nenhum trabalho em
 * GCP/Terraform/AWS tem como alcançar o código do Azure.
 *
 * Se este teste falhar, alguém acoplou o Azure a outro pacote @iacmp (ver
 * docs/roadmap-fase2.md §0). Resolva removendo o import, não relaxando a regra.
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

describe('isolamento de arquitetura — provider Azure', () => {
  const srcDir = path.join(__dirname, '..', 'src');

  it('só importa @iacmp/core (nenhum outro provider ou pacote @iacmp)', () => {
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
