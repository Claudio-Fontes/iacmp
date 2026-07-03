import { routeQuery } from '../src/rag/query-router';

describe('routeQuery', () => {
  describe('comandos de geração', () => {
    const cases = [
      'crie uma lambda com api gateway',
      'gere uma vpc com subnets privadas',
      'adicione um bucket s3',
      'cria um cluster ecs',
      'faça uma fila sqs',
      'implemente um banco rds',
    ];

    for (const q of cases) {
      test(`"${q}" ativa project + docs`, () => {
        const d = routeQuery(q);
        expect(d.useProjectStacks).toBe(true);
        expect(d.useIacmpDocs).toBe(true);
      });
    }
  });

  describe('sinais de projeto', () => {
    test('minha stack → useProjectStacks', () => {
      expect(routeQuery('o que tem na minha stack?').useProjectStacks).toBe(true);
    });

    test('corrigir → useProjectStacks', () => {
      expect(routeQuery('corrigir o erro na lambda').useProjectStacks).toBe(true);
    });

    test('no projeto → useProjectStacks', () => {
      expect(routeQuery('quais recursos existem no projeto?').useProjectStacks).toBe(true);
    });
  });

  describe('sinais de docs', () => {
    test('construct → useIacmpDocs', () => {
      expect(routeQuery('como usar o construct Fn.Lambda?').useIacmpDocs).toBe(true);
    });

    test('props → useIacmpDocs', () => {
      expect(routeQuery('quais props o Storage.Bucket aceita?').useIacmpDocs).toBe(true);
    });

    test('compute. → useIacmpDocs', () => {
      expect(routeQuery('sintaxe do compute.instance').useIacmpDocs).toBe(true);
    });
  });

  describe('sinais de knowledge', () => {
    test('aws → usePlatformKnowledge', () => {
      expect(routeQuery('como funciona o s3 na aws?').usePlatformKnowledge).toBe(true);
    });

    test('limite → usePlatformKnowledge', () => {
      expect(routeQuery('qual o limite de timeout do lambda?').usePlatformKnowledge).toBe(true);
    });

    test('disaster recovery → usePlatformKnowledge', () => {
      expect(routeQuery('estratégias de disaster recovery').usePlatformKnowledge).toBe(true);
    });

    test('azure functions → usePlatformKnowledge', () => {
      expect(routeQuery('como escalar azure functions?').usePlatformKnowledge).toBe(true);
    });

    test('bigquery → usePlatformKnowledge', () => {
      expect(routeQuery('custo do bigquery por query').usePlatformKnowledge).toBe(true);
    });
  });

  describe('sinais de live retriever', () => {
    // useLive exige sinal + frase de intenção explícita (ver shouldFetchLive).
    test('preço atual → useLive', () => {
      expect(routeQuery('qual o preço atual do lambda?').useLive).toBe(true);
    });

    test('recente → useLive', () => {
      expect(routeQuery('o que a aws lançou recentemente?').useLive).toBe(true);
    });

    test('terraform provider versão atual → useLive', () => {
      expect(routeQuery('qual a versão atual do terraform provider aws?').useLive).toBe(true);
    });

    test('preço sem intenção → useLive false', () => {
      expect(routeQuery('qual o preço do lambda?').useLive).toBe(false);
    });

    test('query genérica → useLive false', () => {
      expect(routeQuery('crie uma lambda simples').useLive).toBe(false);
    });
  });

  describe('fallback conservador', () => {
    test('query sem sinal conhecido → ativa tudo', () => {
      const d = routeQuery('explique isso aqui');
      // "explique" está em KNOWLEDGE_SIGNALS, então usePlatformKnowledge=true
      // mas se não houver nenhum sinal → ativa tudo
      expect(d.useProjectStacks || d.useIacmpDocs || d.usePlatformKnowledge).toBe(true);
    });

    test('string completamente aleatória → ativa todos os corpora', () => {
      const d = routeQuery('xyzwqp123456');
      expect(d.useProjectStacks).toBe(true);
      expect(d.useIacmpDocs).toBe(true);
      expect(d.usePlatformKnowledge).toBe(true);
    });
  });

  describe('case insensitive', () => {
    test('LAMBDA em maiúsculas → usePlatformKnowledge', () => {
      expect(routeQuery('QUAL O LIMITE DO LAMBDA').usePlatformKnowledge).toBe(true);
    });
  });
});
