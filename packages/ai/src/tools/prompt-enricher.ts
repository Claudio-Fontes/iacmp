import type { AIProvider } from '../llm-models/base';

const ENRICHMENT_SYSTEM =
  `Você é um especialista em infraestrutura cloud. Analise o prompt e identifique APENAS lacunas que mudariam quais constructs são gerados.

INJETE AUTOMATICAMENTE — nunca pergunte sobre:
- IAM roles/policies (sempre com privilégios mínimos)
- HTTPS/TLS, grupos de segurança, criptografia
- Runtime (Node.js 20), timeouts, memória padrão
- Logging, health checks, regiões padrão

PERGUNTE APENAS quando a resposta muda a arquitetura:
- Banco de dados: tipo (SQL/NoSQL/cache) se claramente necessário mas não especificado
- Autenticação: mecanismo se a API expõe dados sensíveis e não está especificado
- S3/Blob lifecycle: período de retenção se upload de arquivos e não especificado
- Processamento: síncrono (Lambda HTTP) vs assíncrono (fila+worker) se ambíguo

NÃO pergunte se o prompt já deixa claro.
Máximo 2 perguntas, máximo 3 opções cada.

Retorne APENAS JSON sem markdown:
{"questions":[{"q":"Pergunta?","options":["a) opção1","b) opção2","c) opção3"]}]}

Se tudo está claro: {"questions":[]}`;

interface EnrichQuestion {
  q: string;
  options: string[];
}

export async function enrichPrompt(
  provider: AIProvider,
  userPrompt: string,
  iacProvider: string,
  ask: (q: string) => Promise<string>,
): Promise<string> {
  try {
    const response = await provider.chat([
      { role: 'system', content: ENRICHMENT_SYSTEM },
      { role: 'user', content: `Provider alvo: ${iacProvider}\nPrompt: ${userPrompt}` },
    ]);

    let analysis: { questions?: EnrichQuestion[] };
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch?.[0] ?? '{"questions":[]}');
    } catch {
      return userPrompt;
    }

    const questions = (analysis.questions ?? []).slice(0, 2);
    if (questions.length === 0) return userPrompt;

    const answers: string[] = [];
    for (const question of questions) {
      const opts = (question.options ?? []).join('\n');
      const answer = await ask(`\n${question.q}\n${opts}\n> `);
      if (answer.trim()) {
        const letter = answer.trim().toLowerCase().replace(/[)\s.].*/, '');
        const selectedOpt = question.options.find(o => o.toLowerCase().startsWith(letter + ')'));
        answers.push(`${question.q} → ${selectedOpt ?? answer.trim()}`);
      }
    }

    if (answers.length === 0) return userPrompt;
    return `${userPrompt}\n\n[Contexto adicional do usuário:\n${answers.join('\n')}]`;
  } catch {
    return userPrompt;
  }
}
