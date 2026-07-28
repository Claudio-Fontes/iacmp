import * as fs from 'fs';
import * as path from 'path';
import { AiApi, KnowledgeApi } from './types';

export * from './types';

/**
 * Loader dos módulos Pro (@iacmp/ai e @iacmp/knowledge — repo privado
 * iacmp-pro). Ordem de resolução:
 *   1. IACMP_DISABLE_PRO=1 → sempre ausente (usado nos testes para simular a
 *      instalação pública numa máquina de dev que TEM o Pro).
 *   2. require normal (node_modules — symlink criado pelo dev-sync, ou
 *      instalação Pro futura).
 *   3. IACMP_PRO_PATH → raiz de um checkout do iacmp-pro (dist buildado).
 * Ausente → null; quem chama decide entre degradar com mensagem (comandos
 * Pro) ou virar no-op (autolearn).
 */
export const PRO_MESSAGE =
  'Este recurso faz parte do iacmp Pro (geração via IA com corpus validado em deploy real).\n' +
  'O restante do CLI (init/synth/deploy/destroy/diff/diagram) funciona normalmente sem ele.\n' +
  'Saiba mais: https://github.com/Claudio-Fontes/iacmp#iacmp-pro';

function loadProModule<T>(specifier: string, proSubdir: string): T | null {
  if (process.env.IACMP_DISABLE_PRO === '1') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(specifier) as T;
  } catch { /* segue pro fallback */ }
  const proRoot = process.env.IACMP_PRO_PATH;
  if (proRoot) {
    const candidate = path.join(proRoot, 'packages', proSubdir);
    if (fs.existsSync(candidate)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(candidate) as T;
      } catch { /* ausente/não buildado */ }
    }
  }
  return null;
}

let aiCache: AiApi | null | undefined;
export function loadAi(): AiApi | null {
  if (aiCache === undefined) aiCache = loadProModule<AiApi>('@iacmp/ai', 'ai');
  return aiCache;
}

let knowledgeCache: KnowledgeApi | null | undefined;
export function loadKnowledge(): KnowledgeApi | null {
  if (knowledgeCache === undefined) knowledgeCache = loadProModule<KnowledgeApi>('@iacmp/knowledge', 'knowledge');
  return knowledgeCache;
}

/** Como loadAi(), mas lança com a mensagem Pro quando ausente — para os pontos onde a geração é o próprio comando. */
export function requireAi(): AiApi {
  const ai = loadAi();
  if (!ai) throw new Error(PRO_MESSAGE);
  return ai;
}
