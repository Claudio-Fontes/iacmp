// Loop de aprendizado — Modo 1 (local, client-side). Após um deploy inédito
// bem-sucedido, oferece gravar o padrão na base LOCAL do próprio cliente
// (~/.iacmp/knowledge.db, origin='local'). Fica só nele; nada é enviado.
//
// Desenhado forward-compatible com o Modo 2 (compartilhado/central):
//  - pipeline em etapas separadas: buildCandidate → generalize → persistir;
//  - candidato com título GENÉRICO (dos constructs, nunca do nome do projeto),
//    para já nascer sem dado da empresa;
//  - id determinístico por fingerprint (a central futura deduplica por ele);
//  - proveniência gravada (shareStatus:'private' hoje).
// Quando o Modo 2 chegar, o destino "persistir" ganha um irmão "compartilhar" e
// `generalize` passa a anonimizar de fato — sem tocar na captura.

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { loadKnowledge, type Provenance } from './pro';
import { IacmpConfig } from './utils';
import { t } from './i18n';

const CANDIDATE_SCHEMA_VERSION = 1;

// Lê recursivamente os .ts de um diretório → { relPath: conteúdo }.
function readTsTree(root: string, baseLabel: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const rel = baseLabel + '/' + path.relative(root, full).split(path.sep).join('/');
        out[rel] = fs.readFileSync(full, 'utf-8');
      }
    }
  };
  walk(root);
  return out;
}

// Constructs instanciados nas stacks (`new Familia.Tipo(...)`). Usa o TIPO em
// minúsculas — consistente para a dedup (não precisa bater 1:1 com o vocabulário
// curado; a dedup principal é do cliente contra o próprio banco).
function extractConstructs(stacks: Record<string, string>): string[] {
  const found = new Set<string>();
  const re = /new\s+[A-Z]\w*\.([A-Z]\w*)\s*\(/g;
  for (const code of Object.values(stacks)) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) found.add(m[1].toLowerCase());
  }
  return [...found].sort();
}

export interface Candidate {
  provider: string;
  title: string;
  constructs: string[];
  tags: string[];
  stacks: Record<string, string>;
  handlers: Record<string, string>;
}

// Monta um candidato a partir dos arquivos-fonte do projeto. Título genérico
// (derivado dos constructs, nunca de config.name). Retorna null se não houver o
// que aprender.
export function buildCandidate(cwd: string, provider: string): Candidate | null {
  const stacks = readTsTree(path.join(cwd, 'stacks'), 'stacks');
  if (Object.keys(stacks).length === 0) return null;
  const handlers = readTsTree(path.join(cwd, 'src'), 'src');
  const constructs = extractConstructs(stacks);
  if (constructs.length === 0) return null;
  const title = `${provider.toUpperCase()} · ${constructs.slice(0, 4).join(' + ')}`;
  const tags = [provider, ...constructs];
  return { provider, title, constructs, tags, stacks, handlers };
}

// Slot de generalização. Modo 1 (base local privada) = no-op: guarda como está.
// Modo 2 (compartilhado) plugará aqui a anonimização (trocar nomes, esqueletizar
// handlers) antes de enviar à central.
export function generalize(c: Candidate, level: 'none' | 'share'): Candidate {
  if (level === 'none') return c;
  throw new Error(t('generalização para compartilhamento (Modo 2) ainda não implementada', 'generalization for sharing (Mode 2) not implemented yet'));
}

export interface LearnDeps {
  log: (msg: string) => void;
  confirm: (msg: string) => Promise<boolean>;
  isTTY: boolean;
  now: () => string; // ISO 8601
}

// Auto-aprendizado local pós-deploy. Sem opt-in, é no-op silencioso e barato.
// Nunca lança para o chamador (deploy já concluiu) — falha vira aviso.
export async function maybeLearn(
  cwd: string,
  provider: string,
  config: IacmpConfig,
  deps: LearnDeps,
): Promise<void> {
  if (config.knowledge?.autolearn !== 'local') return;

  // Autolearn escreve na base local via @iacmp/knowledge (módulo Pro). Sem ele
  // instalado, vira no-op com um aviso discreto — o deploy JÁ concluiu e nunca
  // pode quebrar por causa disso.
  const kb = loadKnowledge();
  if (!kb) {
    deps.log(chalk.dim(t('  autolearn ativado no iacmp.json, mas o módulo Pro (@iacmp/knowledge) não está instalado — pulando.', '  autolearn enabled in iacmp.json, but the Pro module (@iacmp/knowledge) is not installed — skipping.')));
    return;
  }

  let candidate: Candidate | null;
  try { candidate = buildCandidate(cwd, provider); } catch { return; }
  if (!candidate) return;

  const dbPath = kb.defaultDbPath();
  try {
    // Padrão já conhecido (curado ou já aprendido) → nada a fazer.
    if (kb.hasSimilarExample({ dbPath }, provider, candidate.constructs)) return;
  } catch { return; }

  const c = generalize(candidate, 'none');

  // Preview: o cliente vê EXATAMENTE o que entraria na base dele.
  deps.log('');
  deps.log(chalk.bold(t('Aprendizado local — padrão inédito neste deploy:', 'Local learning — pattern never seen before in this deploy:')));
  deps.log(t(`  título:     ${c.title}`, `  title:      ${c.title}`));
  deps.log(`  constructs: ${c.constructs.join(', ')}`);
  deps.log(t(
    `  arquivos:   ${Object.keys(c.stacks).length} stack(s), ${Object.keys(c.handlers).length} handler(s)`,
    `  files:      ${Object.keys(c.stacks).length} stack(s), ${Object.keys(c.handlers).length} handler(s)`,
  ));
  deps.log(chalk.dim(t('  (fica só na SUA base local — nada é enviado)', '  (stays only in YOUR local knowledge base — nothing is sent)')));

  if (!deps.isTTY) {
    deps.log(chalk.dim(t('  stdin não interativo — pulei; rode num terminal para confirmar.', '  non-interactive stdin — skipped; run in a terminal to confirm.')));
    return;
  }
  const ok = await deps.confirm(t('Adicionar este padrão à sua base LOCAL de conhecimento?', 'Add this pattern to your LOCAL knowledge base?'));
  if (!ok) { deps.log(chalk.dim(t('  ok, não adicionado.', '  ok, not added.'))); return; }

  const fp = kb.fingerprintOf(provider, c.constructs);
  const provenance: Provenance = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    capturedAt: deps.now(),
    fingerprint: fp,
    shareStatus: 'private',
  };
  try {
    kb.addLocalExample({ dbPath }, {
      id: `local-${fp}`,
      title: c.title,
      provider,
      constructs: c.constructs,
      tags: c.tags,
      stacks: c.stacks,
      handlers: c.handlers,
      notes: [],
      validated: true,
    }, provenance);
    deps.log(chalk.green(t('  ✓ aprendido — sua base local reforça esse padrão nas próximas gerações.', '  ✓ learned — your local knowledge base reinforces this pattern in future generations.')));
  } catch (err) {
    deps.log(chalk.dim(t(`  não consegui gravar (${(err as Error).message}) — seguindo.`, `  could not save (${(err as Error).message}) — moving on.`)));
  }
}
