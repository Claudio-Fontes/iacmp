import { extractResponse } from '../src/parser/code-extractor';

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
});
