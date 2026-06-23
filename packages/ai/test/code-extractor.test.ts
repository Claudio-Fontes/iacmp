import {
  extractResponse,
  MAX_FILES,
  MAX_DELETIONS,
  MAX_FILE_BYTES,
} from '../src/parser/code-extractor';

const validResponse = {
  explanation: 'Cria uma Lambda com API Gateway',
  files: [
    { path: 'stacks/api.ts', content: 'const stack = new Stack("api");' },
  ],
  deletions: [],
  nextSteps: ['rodar iacmp synth'],
  warnings: [],
};

describe('extractResponse', () => {
  test('parseia JSON puro', () => {
    const result = extractResponse(JSON.stringify(validResponse));
    expect(result.explanation).toBe('Cria uma Lambda com API Gateway');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('stacks/api.ts');
  });

  test('parseia JSON dentro de bloco ```json```', () => {
    const raw = `Aqui está o resultado:\n\`\`\`json\n${JSON.stringify(validResponse)}\n\`\`\``;
    const result = extractResponse(raw);
    expect(result.files).toHaveLength(1);
  });

  test('parseia JSON dentro de bloco ``` sem linguagem', () => {
    const raw = `\`\`\`\n${JSON.stringify(validResponse)}\n\`\`\``;
    const result = extractResponse(raw);
    expect(result.explanation).toBe('Cria uma Lambda com API Gateway');
  });

  test('parseia JSON com texto antes e depois', () => {
    const raw = `Vou criar a stack para você.\n${JSON.stringify(validResponse)}\nQualquer dúvida é só falar.`;
    const result = extractResponse(raw);
    expect(result.files).toHaveLength(1);
  });

  test('regressao: modelo "pensa alto" e devolve DOIS blocos ```json``` (rascunho + correção) → usa o ÚLTIMO, não o primeiro', () => {
    const draft = { explanation: 'rascunho com erro', files: [{ path: 'a.ts', content: 'quebrado' }], deletions: [], nextSteps: [], warnings: [] };
    const fixed = { explanation: 'versão corrigida', files: [{ path: 'a.ts', content: 'certo' }, { path: 'b.ts', content: 'tambem certo' }], deletions: [], nextSteps: [], warnings: [] };
    const raw = `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n\nErrei, deixa eu reescrever:\n\n\`\`\`json\n${JSON.stringify(fixed)}\n\`\`\``;
    const result = extractResponse(raw);
    expect(result.explanation).toBe('versão corrigida');
    expect(result.files).toHaveLength(2);
  });

  test('campos ausentes recebem defaults', () => {
    const minimal = JSON.stringify({ explanation: 'ok', files: [] });
    const result = extractResponse(minimal);
    expect(result.deletions).toEqual([]);
    expect(result.nextSteps).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('files sem deletions → deletions = []', () => {
    const r = extractResponse(JSON.stringify({ explanation: 'x', files: [{ path: 'a.ts', content: 'x' }] }));
    expect(r.deletions).toEqual([]);
  });

  test('lança erro para JSON inválido', () => {
    expect(() => extractResponse('texto completamente inválido sem json')).toThrow();
  });

  test('lança erro para JSON sem explanation', () => {
    expect(() => extractResponse(JSON.stringify({ files: [] }))).toThrow();
  });

  test('lança erro para files não sendo array', () => {
    expect(() => extractResponse(JSON.stringify({ explanation: 'ok', files: 'wrong' }))).toThrow();
  });

  test('nextSteps é array de strings', () => {
    const result = extractResponse(JSON.stringify({
      ...validResponse,
      nextSteps: ['passo 1', 'passo 2'],
    }));
    expect(result.nextSteps).toEqual(['passo 1', 'passo 2']);
  });

  test('warnings é propagado', () => {
    const result = extractResponse(JSON.stringify({
      ...validResponse,
      warnings: ['atenção: custo elevado'],
    }));
    expect(result.warnings).toContain('atenção: custo elevado');
  });

  test('múltiplos files são preservados', () => {
    const result = extractResponse(JSON.stringify({
      ...validResponse,
      files: [
        { path: 'stacks/api.ts', content: 'a' },
        { path: 'stacks/db.ts', content: 'b' },
        { path: 'stacks/network.ts', content: 'c' },
      ],
    }));
    expect(result.files).toHaveLength(3);
  });

  describe('limites defensivos', () => {
    test('rejeita resposta com mais de MAX_FILES arquivos', () => {
      const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
        path: `stacks/s${i}.ts`,
        content: 'x',
      }));
      expect(() => extractResponse(JSON.stringify({ ...validResponse, files }))).toThrow(/limite de arquivos/i);
    });

    test('aceita resposta com exatamente MAX_FILES arquivos', () => {
      const files = Array.from({ length: MAX_FILES }, (_, i) => ({
        path: `stacks/s${i}.ts`,
        content: 'x',
      }));
      const result = extractResponse(JSON.stringify({ ...validResponse, files }));
      expect(result.files).toHaveLength(MAX_FILES);
    });

    test('rejeita resposta com mais de MAX_DELETIONS remocoes', () => {
      const deletions = Array.from({ length: MAX_DELETIONS + 1 }, (_, i) => `stacks/old-${i}.ts`);
      expect(() => extractResponse(JSON.stringify({ ...validResponse, deletions }))).toThrow(/limite de remoções/i);
    });

    test('aceita resposta com exatamente MAX_DELETIONS remocoes', () => {
      const deletions = Array.from({ length: MAX_DELETIONS }, (_, i) => `stacks/old-${i}.ts`);
      const result = extractResponse(JSON.stringify({ ...validResponse, deletions }));
      expect(result.deletions).toHaveLength(MAX_DELETIONS);
    });

    test('rejeita arquivo com conteudo acima de MAX_FILE_BYTES', () => {
      const big = 'x'.repeat(MAX_FILE_BYTES + 1);
      expect(() => extractResponse(JSON.stringify({
        ...validResponse,
        files: [{ path: 'stacks/big.ts', content: big }],
      }))).toThrow(/limite de tamanho/i);
    });

    test('aceita arquivo com conteudo exatamente no limite', () => {
      const justRight = 'x'.repeat(MAX_FILE_BYTES);
      const result = extractResponse(JSON.stringify({
        ...validResponse,
        files: [{ path: 'stacks/ok.ts', content: justRight }],
      }));
      expect(result.files).toHaveLength(1);
    });
  });
});
