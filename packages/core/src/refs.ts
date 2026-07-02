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
 * FONTE ÚNICA DE VERDADE: atributos referenciáveis por tipo de construct.
 * Derivada dos Outputs que o synth exporta hoje (cloudformation.ts) e dos
 * sufixos aceitos pelos resolvers (resolveEnvVarValue, resolvePolicyResource).
 */
export interface ConstructAttributeMap {
  'Secret.Vault':          'SecretArn' | 'Arn';
  'Database.SQL':          'Endpoint' | 'Port' | 'SecretArn' | 'Password' | 'Username';
  'Database.DocumentDB':   'Endpoint' | 'Port' | 'SecretArn' | 'Password';
  'Database.DynamoDB':     'Arn' | 'Name';
  'Cache.Redis':           'Endpoint' | 'Port';
  'Messaging.Queue':       'Arn' | 'QueueUrl' | 'QueueArn';
  'Messaging.Topic':       'Arn' | 'TopicArn';
  'Messaging.Stream':      'Arn' | 'Name';
  'Function.Lambda':       'Arn';
  'Network.LoadBalancer':  'TargetGroupArn' | 'DnsName';
  'Network.WAF':           'Arn';
  'Storage.Bucket':        'Arn' | 'Name';
  'Network.VPC':           'VpcId';
  'Network.Subnet':        'SubnetId';
  'Network.SecurityGroup': 'GroupId';
}

export const CONSTRUCT_ATTRIBUTES = {
  'Secret.Vault':          ['SecretArn', 'Arn'],
  'Database.SQL':          ['Endpoint', 'Port', 'SecretArn', 'Password', 'Username'],
  'Database.DocumentDB':   ['Endpoint', 'Port', 'SecretArn', 'Password'],
  'Database.DynamoDB':     ['Arn', 'Name'],
  'Cache.Redis':           ['Endpoint', 'Port'],
  'Messaging.Queue':       ['Arn', 'QueueUrl', 'QueueArn'],
  'Messaging.Topic':       ['Arn', 'TopicArn'],
  'Messaging.Stream':      ['Arn', 'Name'],
  'Function.Lambda':       ['Arn'],
  'Network.LoadBalancer':  ['TargetGroupArn', 'DnsName'],
  'Network.WAF':           ['Arn'],
  'Storage.Bucket':        ['Arn', 'Name'],
  'Network.VPC':           ['VpcId'],
  'Network.Subnet':        ['SubnetId'],
  'Network.SecurityGroup': ['GroupId'],
} as const satisfies { [K in keyof ConstructAttributeMap]: ReadonlyArray<ConstructAttributeMap[K]> };
