import { getExecutor } from '../../src/deploy';

describe('getExecutor', () => {
  test('resolve os 4 providers suportados', () => {
    expect(getExecutor('aws').provider).toBe('aws');
    expect(getExecutor('azure').provider).toBe('azure');
    expect(getExecutor('gcp').provider).toBe('gcp');
    expect(getExecutor('terraform').provider).toBe('terraform');
  });

  test('lança erro claro para provider desconhecido', () => {
    expect(() => getExecutor('oraculo')).toThrow('Provider desconhecido: oraculo');
  });
});
