import { generateHtml } from '../src/ui';
import type { ProjectInfo } from '../src/ui';

const FIXED_DATE = new Date('2024-01-15T10:00:00.000Z');

beforeAll(() => {
  jest.useFakeTimers({ now: FIXED_DATE });
});

afterAll(() => {
  jest.useRealTimers();
});

const BASE_INFO: ProjectInfo = {
  name: 'meu-projeto',
  provider: 'aws',
  region: 'us-east-1',
  stacks: [
    {
      name: 'app-stack',
      provider: 'aws',
      resources: [
        { type: 'Compute.Instance', id: 'AppServer' },
        { type: 'Storage.Bucket', id: 'AppBucket' },
      ],
    },
  ],
};

describe('generateHtml', () => {
  test('retorna string HTML nao-vazia', () => {
    const html = generateHtml(BASE_INFO);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
  });

  test('snapshot com constructs fixos', () => {
    expect(generateHtml(BASE_INFO)).toMatchSnapshot();
  });

  test('inclui nome do projeto, provider e regiao no output', () => {
    const html = generateHtml(BASE_INFO);
    expect(html).toContain('meu-projeto');
    expect(html).toContain('aws');
    expect(html).toContain('us-east-1');
  });

  test('inclui recursos da stack no output', () => {
    const html = generateHtml(BASE_INFO);
    expect(html).toContain('app-stack');
    expect(html).toContain('Compute.Instance');
    expect(html).toContain('AppServer');
    expect(html).toContain('Storage.Bucket');
    expect(html).toContain('AppBucket');
  });

  test('mostra mensagem de stacks vazias quando nao ha stacks', () => {
    const info: ProjectInfo = { name: 'vazio', provider: 'azure', region: 'eastus', stacks: [] };
    const html = generateHtml(info);
    expect(html).toContain('iacmp synth');
    expect(html).not.toContain('<div class="card">');
  });

  test('escapa caracteres HTML especiais no nome do projeto', () => {
    const info: ProjectInfo = {
      name: '<script>alert("xss")</script>',
      provider: 'gcp',
      region: 'us-central1',
      stacks: [],
    };
    const html = generateHtml(info);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapa caracteres HTML especiais em ids de recursos', () => {
    const info: ProjectInfo = {
      name: 'proj',
      provider: 'aws',
      region: 'us-east-1',
      stacks: [
        {
          name: 'stack',
          provider: 'aws',
          resources: [{ type: 'Compute.Instance', id: '<malicioso>' }],
        },
      ],
    };
    const html = generateHtml(info);
    expect(html).not.toContain('<malicioso>');
    expect(html).toContain('&lt;malicioso&gt;');
  });

  test('exibe badge com contagem correta de recursos', () => {
    const html = generateHtml(BASE_INFO);
    expect(html).toContain('2 recurso(s)');
  });

  test('exibe mensagem de nenhum recurso para stack vazia', () => {
    const info: ProjectInfo = {
      name: 'proj',
      provider: 'aws',
      region: 'us-east-1',
      stacks: [{ name: 'stack-vazia', provider: 'aws', resources: [] }],
    };
    const html = generateHtml(info);
    expect(html).toContain('Nenhum recurso sintetizado.');
  });
});
