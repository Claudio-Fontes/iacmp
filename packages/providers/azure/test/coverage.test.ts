import {
  Stack,
  Compute,
  Storage,
  Network,
  Database,
  Fn,
  Cache,
  Messaging,
  Secret,
  Certificate,
  Custom,
  Policy,
  Workflow,
  Events,
  Monitoring,
  Logging,
  CONSTRUCT_TYPES,
  type ConstructType,
} from '@iacmp/core';
import { emitBicep } from '../src';

// Tipos sem handler no synth Azure: nenhum hoje — todo tipo do catálogo emite
// algo ou é no-op documentado. Se um tipo novo ficar sem handler, o teste
// abaixo falha e ele deve ser implementado ou adicionado aqui com comentário.
const UNSUPPORTED: ConstructType[] = [];

type AnyProps = Record<string, unknown>;

// Minimum valid props por tipo (espelha o coverage do AWS).
const MINIMAL_PROPS: Partial<Record<ConstructType, AnyProps>> = {
  'Certificate.TLS':       { domainName: 'example.com' },
  'Compute.AutoScaling':   { instanceType: 'small', image: 'ubuntu-22.04', minCapacity: 1, maxCapacity: 3 },
  'Compute.Container':     { image: 'nginx:latest' },
  'Compute.Instance':      { instanceType: 'small', image: 'ubuntu-22.04' },
  'Compute.Kubernetes':    {},
  'Database.DynamoDB':     { partitionKey: 'id' },
  'Database.SQL':          { engine: 'postgres' },
  'Function.ApiGateway':   { name: 'MyApi' },
  'Function.Lambda':       { runtime: 'nodejs20', handler: 'index.handler', code: 'x' },
  'Monitoring.Alarm':      { metricName: 'CPUUtilization', threshold: 80 },
  'Monitoring.Dashboard':  { widgets: [{ type: 'metric', title: 'Test', metricName: 'CPUUtilization', namespace: 'AWS/EC2' }] },
  'Network.CDN':           { origins: [{ domainName: 'example.com', id: 'origin1' }] },
  'Network.Dns':           { zoneName: 'example.com', records: [{ name: 'www', type: 'A', values: ['1.2.3.4'] }] },
  'Network.LoadBalancer':  { vpcId: 'vpc-1234', subnetIds: ['subnet-a', 'subnet-b'] },
  'Network.SecurityGroup': { vpcId: 'vpc-1234' },
  'Network.Subnet':        { vpcId: 'vpc-1234', cidr: '10.0.1.0/24' },
  'Network.VpcEndpoint':   { vpcId: 'vpc-1234', services: ['s3'], subnetIds: ['subnet-1234'] },
  'Network.WAF':           { scope: 'REGIONAL' },
  'Policy.IAM':            { attachTo: 'MyLambda', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['s3:GetObject'] }] },
  'Workflow.StepFunctions': { steps: [{ name: 'Step1', type: 'Pass' }] },
};

function makeConstruct(type: ConstructType, stack: Stack): void {
  const props = (MINIMAL_PROPS[type] ?? {}) as AnyProps;
  switch (type) {
    case 'Cache.Memcached':      new Cache.Memcached(stack, 'c', props as never); break;
    case 'Cache.Redis':          new Cache.Redis(stack, 'c', props as never); break;
    case 'Certificate.TLS':      new Certificate.TLS(stack, 'c', props as never); break;
    case 'Compute.AutoScaling':  new Compute.AutoScaling(stack, 'c', props as never); break;
    case 'Compute.Container':    new Compute.Container(stack, 'c', props as never); break;
    case 'Compute.Instance':     new Compute.Instance(stack, 'c', props as never); break;
    case 'Compute.Kubernetes':   new Compute.Kubernetes(stack, 'c', props as never); break;
    case 'Custom.Resource':      new Custom.Resource(stack, 'c', props as never); break;
    case 'Database.DocumentDB':  new Database.DocumentDB(stack, 'c', props as never); break;
    case 'Database.DynamoDB':    new Database.DynamoDB(stack, 'c', props as never); break;
    case 'Database.SQL':         new Database.SQL(stack, 'c', props as never); break;
    case 'Events.EventBridge':   new Events.EventBridge(stack, 'c', props as never); break;
    case 'Function.ApiGateway':  new Fn.ApiGateway(stack, 'c', props as never); break;
    case 'Function.Lambda':      new Fn.Lambda(stack, 'c', props as never); break;
    case 'Logging.Stream':       new Logging.Stream(stack, 'c', props as never); break;
    case 'Messaging.Queue':      new Messaging.Queue(stack, 'c', props as never); break;
    case 'Messaging.Stream':     new Messaging.Stream(stack, 'c', props as never); break;
    case 'Messaging.Topic':      new Messaging.Topic(stack, 'c', props as never); break;
    case 'Monitoring.Alarm':     new Monitoring.Alarm(stack, 'c', props as never); break;
    case 'Monitoring.Dashboard': new Monitoring.Dashboard(stack, 'c', props as never); break;
    case 'Network.CDN':          new Network.CDN(stack, 'c', props as never); break;
    case 'Network.Dns':          new Network.Dns(stack, 'c', props as never); break;
    case 'Network.LoadBalancer': new Network.LoadBalancer(stack, 'c', props as never); break;
    case 'Network.SecurityGroup': new Network.SecurityGroup(stack, 'c', props as never); break;
    case 'Network.Subnet':       new Network.Subnet(stack, 'c', props as never); break;
    case 'Network.VPC':          new Network.VPC(stack, 'c', props as never); break;
    case 'Network.VpcEndpoint':  new Network.VpcEndpoint(stack, 'c', props as never); break;
    case 'Network.WAF':          new Network.WAF(stack, 'c', props as never); break;
    case 'Policy.IAM':
      new Fn.Lambda(stack, 'MyLambda', { runtime: 'nodejs20', handler: 'index.handler', code: 'x' } as never);
      new Policy.IAM(stack, 'c', props as never);
      break;
    case 'Secret.Vault':         new Secret.Vault(stack, 'c', props as never); break;
    case 'Storage.Archive':      new Storage.Archive(stack, 'c', props as never); break;
    case 'Storage.Bucket':       new Storage.Bucket(stack, 'c', props as never); break;
    case 'Storage.FileSystem':   new Storage.FileSystem(stack, 'c', props as never); break;
    case 'Workflow.StepFunctions': new Workflow.StepFunctions(stack, 'c', props as never); break;
  }
}

describe('synth Azure — cobertura por ConstructType', () => {
  const allTypes = Object.keys(CONSTRUCT_TYPES) as ConstructType[];

  test.each(allTypes.filter(t => !UNSUPPORTED.includes(t)))('%s não emite warn "nao suportado" nem lança', (type) => {
    const stack = new Stack(`cov-${type}`);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeConstruct(type, stack);
      emitBicep(stack);
      const unsupportedWarns = warnSpy.mock.calls.filter(
        args => typeof args[0] === 'string' && args[0].includes('nao suportado'),
      );
      expect(unsupportedWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
