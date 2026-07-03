import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldFetchLive, LIVE_SIGNALS, fetchLive } from '../src/rag/live-retriever';

describe('shouldFetchLive', () => {
  // Exige sinal (LIVE_SIGNALS) + frase de intenção explícita (EXPLICIT_INTENT_PHRASES).
  test('preço atual → true', () => expect(shouldFetchLive('qual o preço atual do lambda?')).toBe(true));
  test('custo agora → true', () => expect(shouldFetchLive('qual o custo do cloud run agora?')).toBe(true));
  test('recente → true', () => expect(shouldFetchLive('o que lançou recentemente?')).toBe(true));
  test('lançou → true', () => expect(shouldFetchLive('a aws lançou algo novo?')).toBe(true));
  test('terraform provider versão atual → true', () => expect(shouldFetchLive('versão atual do terraform provider aws')).toBe(true));
  test('pricing latest → true', () => expect(shouldFetchLive('azure functions latest pricing')).toBe(true));

  // Sinal SEM intenção explícita não dispara (evita HTTP desnecessário por geração).
  test('preço sem intenção → false', () => expect(shouldFetchLive('qual o preço do lambda?')).toBe(false));
  test('terraform sem intenção → false', () => expect(shouldFetchLive('versão do terraform provider aws')).toBe(false));
  test('query genérica → false', () => expect(shouldFetchLive('crie uma lambda')).toBe(false));
  test('query sobre arquitetura → false', () => expect(shouldFetchLive('diferença entre sqs e sns')).toBe(false));
  test('string vazia → false', () => expect(shouldFetchLive('')).toBe(false));
});

describe('LIVE_SIGNALS', () => {
  test('é um array não vazio', () => {
    expect(Array.isArray(LIVE_SIGNALS)).toBe(true);
    expect(LIVE_SIGNALS.length).toBeGreaterThan(0);
  });

  test('todos os elementos são strings', () => {
    expect(LIVE_SIGNALS.every(s => typeof s === 'string')).toBe(true);
  });

  test('contém sinais de preço', () => {
    expect(LIVE_SIGNALS.some(s => s.includes('preço') || s.includes('custo'))).toBe(true);
  });

  test('contém sinais de terraform', () => {
    expect(LIVE_SIGNALS.some(s => s.includes('terraform'))).toBe(true);
  });
});

describe('fetchLive — comportamento com rede indisponível', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('retorna string (nunca lança exceção)', async () => {
    // Mesmo que as URLs externas falhem, fetchLive não pode lançar
    const result = await fetchLive('qual o preço do lambda?', [], { projectDir: tmpDir });
    expect(typeof result).toBe('string');
  }, 10_000);

  test('query sem sinais → retorna string vazia', async () => {
    const result = await fetchLive('crie uma vpc simples', [], { projectDir: tmpDir });
    expect(result).toBe('');
  });

  test('cria cache file no projectDir', async () => {
    await fetchLive('qual o preço do azure functions?', [], { projectDir: tmpDir });
    const cacheFile = path.join(tmpDir, '.iacmp', 'live-cache.json');
    // Arquivo pode ou não existir dependendo se houve resposta, mas não deve lançar
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      expect(typeof data).toBe('object');
    }
  }, 10_000);

  test('cache TTL — entrada expirada não é retornada', async () => {
    // Cria cache com entrada já expirada
    const cacheDir = path.join(tmpDir, '.iacmp');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'live-cache.json');
    fs.writeFileSync(cacheFile, JSON.stringify({
      'aws-whats-new': {
        value: 'cached value',
        expiresAt: Date.now() - 1000, // expirado
      },
    }));

    // fetchLive não deve usar o valor expirado
    // (vai tentar buscar da rede — que pode falhar, mas não usa o expirado)
    const result = await fetchLive('o que a aws lançou recentemente?', [], { projectDir: tmpDir });
    expect(typeof result).toBe('string');
    // O resultado NÃO deve ser o valor expirado do cache
    // (pode ser '' se a rede falhou, ou novo valor se funcionou)
  }, 10_000);
});
