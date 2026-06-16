export interface GeneratedFile {
  path: string;
  content: string;
}

export interface AIGeneratedResponse {
  explanation: string;
  files: GeneratedFile[];
  deletions: string[];
  nextSteps: string[];
  warnings: string[];
}

// Limites defensivos para resposta da IA — evita estouro de memoria/disco
// caso o LLM gere lixo, fique em loop ou seja induzido a abuso.
export const MAX_FILES = 50;
export const MAX_DELETIONS = 100;
export const MAX_FILE_BYTES = 256 * 1024;

export function extractResponse(raw: string): AIGeneratedResponse {
  const trimmed = raw.trim();

  // Tenta parse direto
  const direct = tryParse(trimmed);
  if (direct) return validate(direct);

  // Tenta extrair de bloco de código markdown
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    const parsed = tryParse(codeBlock[1].trim());
    if (parsed) return validate(parsed);
  }

  // Tenta extrair entre o primeiro { e o último }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParse(slice);
    if (parsed) return validate(parsed);
  }

  throw new Error(
    'Não foi possível extrair JSON do response da IA.\n' +
    'Response recebido:\n' +
    trimmed.slice(0, 300) +
    (trimmed.length > 300 ? '...' : '')
  );
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validate(obj: unknown): AIGeneratedResponse {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Response da IA não é um objeto JSON válido.');
  }

  const o = obj as Record<string, unknown>;

  if (typeof o['explanation'] !== 'string') {
    throw new Error('Response da IA está faltando o campo "explanation" (string).');
  }

  if (!Array.isArray(o['files'])) {
    throw new Error('Response da IA está faltando o campo "files" (array).');
  }

  const rawFiles = o['files'] as unknown[];
  if (rawFiles.length > MAX_FILES) {
    throw new Error(
      `Response da IA excede o limite de arquivos: ${rawFiles.length} > ${MAX_FILES}. ` +
      `Reduza o escopo da requisição.`
    );
  }

  const files: GeneratedFile[] = [];
  for (const f of rawFiles) {
    if (typeof f !== 'object' || f === null) {
      throw new Error('Cada item em "files" deve ser um objeto com "path" e "content".');
    }
    const file = f as Record<string, unknown>;
    if (typeof file['path'] !== 'string' || typeof file['content'] !== 'string') {
      throw new Error('Cada arquivo deve ter "path" (string) e "content" (string).');
    }
    const byteLen = Buffer.byteLength(file['content'], 'utf-8');
    if (byteLen > MAX_FILE_BYTES) {
      throw new Error(
        `Arquivo "${file['path']}" excede o limite de tamanho: ${byteLen} bytes > ${MAX_FILE_BYTES} bytes. ` +
        `Divida o conteúdo em arquivos menores.`
      );
    }
    files.push({ path: file['path'], content: file['content'] });
  }

  const rawDeletions = Array.isArray(o['deletions'])
    ? (o['deletions'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (rawDeletions.length > MAX_DELETIONS) {
    throw new Error(
      `Response da IA excede o limite de remoções: ${rawDeletions.length} > ${MAX_DELETIONS}. ` +
      `Reduza o escopo da requisição.`
    );
  }

  return {
    explanation: o['explanation'] as string,
    files,
    deletions: rawDeletions,
    nextSteps: Array.isArray(o['nextSteps'])
      ? (o['nextSteps'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    warnings: Array.isArray(o['warnings'])
      ? (o['warnings'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  };
}
