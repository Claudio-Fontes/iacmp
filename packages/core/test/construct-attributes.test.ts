import { CONSTRUCT_TYPES, CONSTRUCT_ATTRIBUTES } from '../src';

// A fonte única de verdade dos atributos referenciáveis por ref() é
// CONSTRUCT_TYPES[type].attributes. Estes testes travam o conteúdo canônico
// (edições passam a ser intencionais) e garantem que a fachada CONSTRUCT_ATTRIBUTES
// deriva dele sem divergir — o problema das "5 tabelas" que a Fase 2 item 2 ataca.
describe('CONSTRUCT_TYPES.attributes — fonte única de verdade (Fase 2 item 2)', () => {
  test('atributos canônicos por tipo (pino)', () => {
    const canonico = (t: string) => CONSTRUCT_TYPES[t as keyof typeof CONSTRUCT_TYPES].attributes;
    expect(canonico('Cache.Redis')).toEqual(['Endpoint', 'Port', 'Host', 'ConnectionString']);
    expect(canonico('Database.SQL')).toEqual(['Endpoint', 'Port', 'SecretArn', 'Password', 'Username']);
    expect(canonico('Database.DocumentDB')).toEqual(['Endpoint', 'Port', 'SecretArn', 'Password', 'ConnectionString']);
    expect(canonico('Database.DynamoDB')).toEqual(['Arn', 'Name', 'ConnectionString']);
    expect(canonico('Messaging.Queue')).toEqual(['Arn', 'QueueUrl', 'QueueArn', 'ConnectionString']);
    expect(canonico('Messaging.Topic')).toEqual(['Arn', 'TopicArn', 'ConnectionString']);
    expect(canonico('Secret.Vault')).toEqual(['SecretArn', 'Arn', 'VaultUri', 'Name', 'SecretValue', 'SecretString']);
    expect(canonico('Storage.Bucket')).toEqual(['Arn', 'Name', 'ConnectionString']);
    expect(canonico('Compute.Container')).toEqual(['Arn', 'Fqdn', 'DnsName']);
    expect(canonico('Function.Lambda')).toEqual(['Arn', 'Fqdn']);
  });

  test('CONSTRUCT_ATTRIBUTES deriva de CONSTRUCT_TYPES sem divergir', () => {
    for (const [type, attrs] of Object.entries(CONSTRUCT_ATTRIBUTES)) {
      expect(attrs).toEqual(CONSTRUCT_TYPES[type as keyof typeof CONSTRUCT_TYPES].attributes);
    }
  });

  test('só tipos com atributos aparecem em CONSTRUCT_ATTRIBUTES', () => {
    for (const attrs of Object.values(CONSTRUCT_ATTRIBUTES)) {
      expect(attrs.length).toBeGreaterThan(0);
    }
  });
});
