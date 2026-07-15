import { CONSTRUCT_TYPES } from './construct-types';

export interface Ref<A extends string = string> {
  readonly kind: 'iacmp:ref';
  readonly constructId: string;
  readonly attribute: A;
}

export function ref<A extends string>(constructId: string, attribute: A): Ref<A> {
  return { kind: 'iacmp:ref', constructId, attribute };
}

export function isRef(value: unknown): value is Ref {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).kind === 'iacmp:ref'
  );
}

/**
 * FONTE ÚNICA DE VERDADE (nível de tipo): atributos referenciáveis por tipo de
 * construct. É a UNIÃO do que qualquer provider resolve — cada provider suporta
 * um subconjunto (ex: ConnectionString/Host/Fqdn são Azure; AWS rejeita alguns).
 * DEVE ficar consistente com `CONSTRUCT_TYPES[type].attributes` (runtime) — o
 * teste de consistência do core trava a divergência. Ao adicionar um atributo
 * resolvível num provider, adicione aqui E no CONSTRUCT_TYPES.
 */
export interface ConstructAttributeMap {
  'Secret.Vault':          'SecretArn' | 'Arn' | 'VaultUri' | 'Name' | 'SecretValue' | 'SecretString';
  'Database.SQL':          'Endpoint' | 'Port' | 'SecretArn' | 'Password' | 'Username';
  'Database.DocumentDB':   'Endpoint' | 'Port' | 'SecretArn' | 'Password' | 'ConnectionString';
  'Database.DynamoDB':     'Arn' | 'Name' | 'ConnectionString';
  'Cache.Redis':           'Endpoint' | 'Port' | 'Host' | 'ConnectionString';
  'Messaging.Queue':       'Arn' | 'QueueUrl' | 'QueueArn' | 'ConnectionString';
  'Messaging.Topic':       'Arn' | 'TopicArn' | 'ConnectionString';
  'Messaging.Stream':      'Arn' | 'Name';
  'Function.Lambda':       'Arn' | 'Fqdn';
  'Compute.Container':     'Arn' | 'Fqdn' | 'DnsName';
  'Network.LoadBalancer':  'TargetGroupArn' | 'DnsName';
  'Network.WAF':           'Arn';
  'Storage.Bucket':        'Arn' | 'Name' | 'ConnectionString';
  'Network.VPC':           'VpcId';
  'Network.Subnet':        'SubnetId';
  'Network.SecurityGroup': 'GroupId';
}

export const CONSTRUCT_ATTRIBUTES = Object.fromEntries(
  Object.entries(CONSTRUCT_TYPES)
    .filter(([, v]) => v.attributes.length > 0)
    .map(([k, v]) => [k, v.attributes]),
) as { [K in keyof ConstructAttributeMap]: ReadonlyArray<ConstructAttributeMap[K]> };
