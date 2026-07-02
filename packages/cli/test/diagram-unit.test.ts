import { Stack, Network, Storage, Database, Fn } from '@iacmp/core';

import { buildModel } from '../src/diagram/builder';
import { renderMermaid } from '../src/diagram/mermaid';
import { renderStructurizr } from '../src/diagram/structurizr';
import { DiagramModel, DiagramStack, DiagramNode } from '../src/diagram/model';

/**
 * Testes unitários (sem subprocess) dos módulos puros de diagrama.
 *
 * Construímos uma Stack real do @iacmp/core (mesma classe que o builder espera),
 * passamos por buildModel() e asseguramos os elementos C4 (nós/relacionamentos),
 * depois serializamos via renderMermaid() e renderStructurizr() e asseguramos a
 * estrutura textual. Tudo determinístico e em memória.
 */

// Helpers de busca no modelo --------------------------------------------------

function findNode(model: DiagramModel, label: string): DiagramNode | undefined {
  for (const s of model.stacks) {
    const n = s.nodes.find(node => node.label === label);
    if (n) return n;
  }
  return undefined;
}

function allNodes(model: DiagramModel): DiagramNode[] {
  return model.stacks.flatMap(s => s.nodes);
}

function allRels(model: DiagramModel): DiagramStack['relationships'] {
  return model.stacks.flatMap(s => s.relationships);
}

// -----------------------------------------------------------------------------

describe('buildModel — construção do modelo C4 a partir de uma Stack', () => {
  test('mapeia metadados de topo do modelo (project/provider/region)', () => {
    const stack = new Stack('s1');
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });

    const model = buildModel('my-proj', 'aws', 'us-east-1', [{ name: 's1', stack }]);

    expect(model.projectName).toBe('my-proj');
    expect(model.provider).toBe('aws');
    expect(model.region).toBe('us-east-1');
    expect(model.stacks).toHaveLength(1);
    expect(model.stacks[0].name).toBe('s1');
  });

  test('cada construct vira um nó com id seguro, label, technology e props', () => {
    const stack = new Stack('main');
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 'main', stack }]);
    const node = findNode(model, 'Assets')!;

    expect(node).toBeDefined();
    // id = safeId("main_Assets") — só [A-Za-z0-9_]
    expect(node.id).toBe('main_Assets');
    expect(node.id).toMatch(/^[A-Za-z0-9_]+$/);
    expect(node.label).toBe('Assets');
    expect(node.constructType).toBe('Storage.Bucket');
    expect(node.technology).toBe('S3 Bucket');
    // props vêm direto do construct
    expect(node.props).toMatchObject({ versioning: true, publicAccess: false });
  });

  test('safeId substitui caracteres não-alfanuméricos por underscore', () => {
    const stack = new Stack('net work');
    new Network.VPC(stack, 'My-Vpc.1', { cidr: '10.0.0.0/16' });

    const model = buildModel('p', 'aws', 'r', [{ name: 'net work', stack }]);
    const node = model.stacks[0].nodes[0];

    // "net work_My-Vpc.1" -> espaço, hífen e ponto viram "_"
    expect(node.id).toBe('net_work_My_Vpc_1');
    expect(node.label).toBe('My-Vpc.1');
  });

  test('describeProps gera descrição específica por tipo (Bucket)', () => {
    const stack = new Stack('s');
    new Storage.Bucket(stack, 'Public', { versioning: false, publicAccess: true });
    new Storage.Bucket(stack, 'Priv', { versioning: true, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);

    expect(findNode(model, 'Public')!.description).toBe('versioning: off, public');
    expect(findNode(model, 'Priv')!.description).toBe('versioning: on, private');
  });

  test('describeProps para VPC inclui cidr e maxAzs', () => {
    const stack = new Stack('s');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 3 });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);
    const node = findNode(model, 'Vpc')!;

    expect(node.description).toBe('cidr: 10.0.0.0/16, maxAzs: 3');
    expect(node.technology).toBe('Virtual Network');
  });

  test('describeProps para Lambda inclui runtime, memory e handler (technology Lambda Function)', () => {
    const stack = new Stack('s');
    new Fn.Lambda(stack, 'Fn1', {
      runtime: 'nodejs20',
      handler: 'i.h',
      code: './s',
      memory: 512,
    });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);
    const node = findNode(model, 'Fn1')!;

    expect(node.description).toBe('runtime: nodejs20, memory: 512MB, handler: i.h');
    expect(node.technology).toBe('Lambda Function');
  });

  test('describeProps para Database.SQL inclui engine, Multi-AZ e size', () => {
    const stack = new Stack('s');
    new Database.SQL(stack, 'Db', {
      engine: 'postgres',
      multiAz: true,
      instanceType: 'db.t3.medium',
    });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);
    const node = findNode(model, 'Db')!;

    expect(node.description).toBe('engine: postgres, Multi-AZ, size: db.t3.medium');
    expect(node.technology).toBe('RDS');
  });

  test('describeProps para Database.SQL sem multiAz omite o "Multi-AZ"', () => {
    const stack = new Stack('s');
    new Database.SQL(stack, 'Db', { engine: 'mysql' });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);
    expect(findNode(model, 'Db')!.description).toBe('engine: mysql');
  });

  test('tipo desconhecido (sem meta) usa fallback technology = constructType', () => {
    // Construct mínimo que NÃO está no TYPE_META.
    const stack = new Stack('s');
    stack.addConstruct({ id: 'Weird', type: 'Custom.Thing', props: {} });

    const model = buildModel('p', 'aws', 'r', [{ name: 's', stack }]);
    const node = findNode(model, 'Weird')!;

    expect(node.constructType).toBe('Custom.Thing');
    expect(node.technology).toBe('Custom.Thing');
    expect(node.description).toBe('');
  });
});

describe('buildModel — inferência de relacionamentos intra-stack', () => {
  test('VPC única → seta tracejada (inferred) para todos os outros nós', () => {
    const stack = new Stack('main');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
    new Storage.Bucket(stack, 'Logs', { versioning: false, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 'main', stack }]);
    const rels = model.stacks[0].relationships;

    const vpcId = findNode(model, 'Vpc')!.id;
    // 1 VPC + 2 buckets => 2 relações VPC->bucket
    const fromVpc = rels.filter(r => r.sourceId === vpcId);
    expect(fromVpc).toHaveLength(2);
    expect(fromVpc.every(r => r.inferred)).toBe(true);
    // não há auto-relação VPC->VPC
    expect(rels.some(r => r.sourceId === vpcId && r.targetId === vpcId)).toBe(false);
    const targets = fromVpc.map(r => r.targetId).sort();
    expect(targets).toEqual([findNode(model, 'Assets')!.id, findNode(model, 'Logs')!.id].sort());
  });

  test('com duas VPCs NÃO infere relação de VPC (vpcs.length === 1 é a condição)', () => {
    const stack = new Stack('main');
    new Network.VPC(stack, 'VpcA', { cidr: '10.0.0.0/16' });
    new Network.VPC(stack, 'VpcB', { cidr: '10.1.0.0/16' });
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 'main', stack }]);
    const vpcA = findNode(model, 'VpcA')!.id;
    const vpcB = findNode(model, 'VpcB')!.id;

    const rels = model.stacks[0].relationships;
    expect(rels.some(r => r.sourceId === vpcA)).toBe(false);
    expect(rels.some(r => r.sourceId === vpcB)).toBe(false);
  });

  test('Lambda + Database.SQL na mesma stack → relação "reads" inferida', () => {
    const stack = new Stack('app');
    new Fn.Lambda(stack, 'Handler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: './src',
    });
    new Database.SQL(stack, 'Db', { engine: 'postgres' });

    const model = buildModel('p', 'aws', 'r', [{ name: 'app', stack }]);
    const rels = model.stacks[0].relationships;

    const lambdaId = findNode(model, 'Handler')!.id;
    const dbId = findNode(model, 'Db')!.id;
    const reads = rels.find(r => r.sourceId === lambdaId && r.targetId === dbId);
    expect(reads).toBeDefined();
    expect(reads!.label).toBe('reads');
    expect(reads!.inferred).toBe(true);
  });

  test('múltiplas Lambdas e Databases geram o produto cartesiano de "reads"', () => {
    const stack = new Stack('app');
    new Fn.Lambda(stack, 'A', { runtime: 'nodejs20', handler: 'a.h', code: './s' });
    new Fn.Lambda(stack, 'B', { runtime: 'nodejs20', handler: 'b.h', code: './s' });
    new Database.SQL(stack, 'D1', { engine: 'postgres' });
    new Database.SQL(stack, 'D2', { engine: 'mysql' });

    const model = buildModel('p', 'aws', 'r', [{ name: 'app', stack }]);
    const reads = model.stacks[0].relationships.filter(r => r.label === 'reads');
    // 2 lambdas × 2 dbs = 4 arestas "reads"
    expect(reads).toHaveLength(4);
    expect(reads.every(r => r.inferred)).toBe(true);
  });

  test('ApiGateway → Lambda via routes[].lambdaId → relação "invokes" NÃO inferida', () => {
    const stack = new Stack('api');
    new Fn.Lambda(stack, 'GetUser', {
      runtime: 'nodejs20',
      handler: 'get.handler',
      code: './src',
    });
    new Fn.ApiGateway(stack, 'Gw', {
      name: 'users-api',
      routes: [{ method: 'GET', path: '/users', lambdaId: 'GetUser' }],
    });

    const model = buildModel('p', 'aws', 'r', [{ name: 'api', stack }]);
    const rels = model.stacks[0].relationships;

    const gwId = findNode(model, 'Gw')!.id;
    const lambdaId = findNode(model, 'GetUser')!.id;
    const invoke = rels.find(r => r.sourceId === gwId && r.targetId === lambdaId);
    expect(invoke).toBeDefined();
    expect(invoke!.label).toBe('invokes');
    expect(invoke!.inferred).toBe(false);
  });

  test('rota com lambdaId inexistente não gera relação invokes', () => {
    const stack = new Stack('api');
    new Fn.ApiGateway(stack, 'Gw', {
      name: 'api',
      routes: [{ method: 'GET', path: '/x', lambdaId: 'NaoExiste' }],
    });

    const model = buildModel('p', 'aws', 'r', [{ name: 'api', stack }]);
    expect(model.stacks[0].relationships.filter(r => r.label === 'invokes')).toHaveLength(0);
  });
});

describe('buildModel — dedup de nós e remoção de stacks vazias', () => {
  test('nós com mesmo id global são deduplicados entre stacks', () => {
    // Duas stacks com mesmo nome de stack E mesmo id de construct geram o mesmo
    // id global "dup_Bucket" → o segundo é removido.
    const s1 = new Stack('dup');
    new Storage.Bucket(s1, 'Bucket', { versioning: true, publicAccess: false });
    const s2 = new Stack('dup');
    new Storage.Bucket(s2, 'Bucket', { versioning: false, publicAccess: true });

    const model = buildModel('p', 'aws', 'r', [
      { name: 'dup', stack: s1 },
      { name: 'dup', stack: s2 },
    ]);

    const dupNodes = allNodes(model).filter(n => n.id === 'dup_Bucket');
    expect(dupNodes).toHaveLength(1);
    // A primeira ocorrência vence (versioning: on).
    expect(dupNodes[0].description).toBe('versioning: on, private');
  });

  test('stack que fica sem nós após dedup é removida do modelo', () => {
    const s1 = new Stack('dup');
    new Storage.Bucket(s1, 'Bucket', { versioning: true, publicAccess: false });
    const s2 = new Stack('dup'); // mesmo nome → mesmo id global, será esvaziada
    new Storage.Bucket(s2, 'Bucket', { versioning: false, publicAccess: true });

    const model = buildModel('p', 'aws', 'r', [
      { name: 'dup', stack: s1 },
      { name: 'dup', stack: s2 },
    ]);

    // Só sobra uma stack (a segunda esvaziou).
    expect(model.stacks).toHaveLength(1);
  });
});

describe('buildModel — inferência cross-stack via environment', () => {
  test('Lambda com env TABLE_NAME aponta para DynamoDB em outra stack ("reads table")', () => {
    const appStack = new Stack('app');
    new Fn.Lambda(appStack, 'Worker', {
      runtime: 'nodejs20',
      handler: 'w.handler',
      code: './src',
      environment: { TABLE_NAME: 'orders' },
    });

    const dataStack = new Stack('data');
    new Database.DynamoDB(dataStack, 'Orders', { partitionKey: 'pk' });

    const model = buildModel('p', 'aws', 'r', [
      { name: 'app', stack: appStack },
      { name: 'data', stack: dataStack },
    ]);

    const workerId = findNode(model, 'Worker')!.id;
    const ordersId = findNode(model, 'Orders')!.id;

    const rel = allRels(model).find(
      r => r.sourceId === workerId && r.targetId === ordersId,
    );
    expect(rel).toBeDefined();
    expect(rel!.label).toBe('reads table');
    expect(rel!.inferred).toBe(true);
    // a relação cross-stack é anexada à stack que contém o nó fonte (app)
    const appDiagram = model.stacks.find(s => s.name === 'app')!;
    expect(appDiagram.relationships.some(r => r.targetId === ordersId)).toBe(true);
  });

  test('env sem hint correspondente não gera relação cross-stack', () => {
    const appStack = new Stack('app');
    new Fn.Lambda(appStack, 'Worker', {
      runtime: 'nodejs20',
      handler: 'w.handler',
      code: './src',
      environment: { FOO: 'bar' },
    });
    const dataStack = new Stack('data');
    new Database.DynamoDB(dataStack, 'Orders', { partitionKey: 'pk' });

    const model = buildModel('p', 'aws', 'r', [
      { name: 'app', stack: appStack },
      { name: 'data', stack: dataStack },
    ]);

    const ordersId = findNode(model, 'Orders')!.id;
    expect(allRels(model).some(r => r.targetId === ordersId)).toBe(false);
  });

  test('relação cross-stack inferida é serializada como "[inferred]" no Structurizr (label some)', () => {
    const appStack = new Stack('app');
    new Fn.Lambda(appStack, 'W', {
      runtime: 'nodejs20',
      handler: 'w.handler',
      code: './src',
      environment: { TABLE_NAME: 'orders' },
    });
    const dataStack = new Stack('data');
    new Database.DynamoDB(dataStack, 'Orders', { partitionKey: 'pk' });

    const model = buildModel('p', 'aws', 'r', [
      { name: 'app', stack: appStack },
      { name: 'data', stack: dataStack },
    ]);

    // o modelo carrega a label semântica...
    const rel = allRels(model).find(r => r.targetId.endsWith('Orders'));
    expect(rel!.label).toBe('reads table');

    // ...mas o renderer Structurizr colapsa relações inferidas para "[inferred]".
    const dsl = renderStructurizr(model);
    expect(dsl).toContain('app_W -> data_Orders "[inferred]" "" "Inferred"');
    // a label semântica NÃO aparece na DSL (só no mermaid via "inferred")
    expect(dsl).not.toContain('"reads table"');
  });

  test('env hint intra-stack: cria relação quando o VALOR referencia o recurso', () => {
    const stack = new Stack('mono');
    new Fn.Lambda(stack, 'Worker', {
      runtime: 'nodejs20',
      handler: 'w.handler',
      code: './src',
      environment: { BUCKET_NAME: 'assets' }, // referencia o bucket 'Assets'
    });
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 'mono', stack }]);

    const workerId = findNode(model, 'Worker')!.id;
    const assetsId = findNode(model, 'Assets')!.id;
    // a relação real Lambda→Bucket na mesma stack DEVE aparecer
    expect(
      allRels(model).some(
        r => r.sourceId === workerId && r.targetId === assetsId && r.label === 'reads bucket',
      ),
    ).toBe(true);
  });

  test('env hint intra-stack: NÃO cria relação quando o valor não referencia o recurso', () => {
    const stack = new Stack('mono');
    new Fn.Lambda(stack, 'Worker', {
      runtime: 'nodejs20',
      handler: 'w.handler',
      code: './src',
      environment: { BUCKET_NAME: 'outro-bucket-qualquer' }, // não referencia 'Assets'
    });
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });

    const model = buildModel('p', 'aws', 'r', [{ name: 'mono', stack }]);

    const workerId = findNode(model, 'Worker')!.id;
    const assetsId = findNode(model, 'Assets')!.id;
    // sem referência pelo valor, não inferimos intra-stack (evita ruído)
    expect(
      allRels(model).some(
        r => r.sourceId === workerId && r.targetId === assetsId && r.label === 'reads bucket',
      ),
    ).toBe(false);
  });
});

describe('renderMermaid — serialização textual', () => {
  function modelWith(): DiagramModel {
    const stack = new Stack('main');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
    return buildModel('demo', 'aws', 'us-east-1', [{ name: 'main', stack }]);
  }

  test('inclui cabeçalho, provider/region e bloco mermaid graph TD', () => {
    const out = renderMermaid(modelWith());

    expect(out).toContain('# Diagramas de Arquitetura — demo');
    expect(out).toContain('**Provider:** aws · **Region:** us-east-1');
    expect(out).toContain('## Stack: main');
    expect(out).toContain('```mermaid');
    expect(out).toContain('graph TD');
    expect(out.trimEnd().endsWith('---')).toBe(true);
  });

  test('emite uma linha de nó por construct com emoji, tipo e descrição em <br/>', () => {
    const out = renderMermaid(modelWith());

    // Nó da VPC: id seguido de ["🌐 Vpc<br/>Network.VPC<br/>cidr: ...<br/>maxAzs: 2"]
    expect(out).toMatch(/main_Vpc\["🌐 Vpc<br\/>Network\.VPC<br\/>cidr: 10\.0\.0\.0\/16, maxAzs: 2"\]/);
    expect(out).toMatch(/main_Assets\["🗂️ Assets<br\/>Storage\.Bucket<br\/>versioning: on, private"\]/);
  });

  test('relação inferida usa seta tracejada -.->|inferred|', () => {
    const out = renderMermaid(modelWith());
    expect(out).toContain('main_Vpc -.->|inferred| main_Assets');
  });

  test('relação explícita usa seta sólida -->|label|', () => {
    const stack = new Stack('api');
    new Fn.Lambda(stack, 'GetUser', { runtime: 'nodejs20', handler: 'g.handler', code: './s' });
    new Fn.ApiGateway(stack, 'Gw', {
      name: 'api',
      routes: [{ method: 'GET', path: '/u', lambdaId: 'GetUser' }],
    });
    const out = renderMermaid(buildModel('demo', 'aws', 'r', [{ name: 'api', stack }]));

    expect(out).toContain('api_Gw -->|invokes| api_GetUser');
    expect(out).not.toContain('api_Gw -.->');
  });

  test('lista de "Recursos" e nota de setas tracejadas quando há inferidos', () => {
    const out = renderMermaid(modelWith());
    expect(out).toContain('**Recursos:**');
    expect(out).toContain('- 🌐 **Vpc** `Network.VPC`');
    expect(out).toContain('Setas tracejadas indicam relações inferidas');
  });

  test('tipo sem emoji conhecido usa fallback "□"', () => {
    const stack = new Stack('s');
    stack.addConstruct({ id: 'X', type: 'Custom.Thing', props: {} });
    const out = renderMermaid(buildModel('p', 'aws', 'r', [{ name: 's', stack }]));
    expect(out).toContain('s_X["□ X<br/>Custom.Thing"]');
  });

  test('modelo sem stacks emite o cabeçalho mas nenhuma seção de stack', () => {
    const out = renderMermaid(buildModel('empty', 'aws', 'r', []));
    expect(out).toContain('# Diagramas de Arquitetura — empty');
    expect(out).not.toContain('## Stack:');
    expect(out).not.toContain('```mermaid');
  });

  test('stack sem relacionamentos não emite a nota de setas tracejadas', () => {
    // Bucket sozinho: nenhuma VPC/Lambda → sem relações inferidas.
    const stack = new Stack('solo');
    new Storage.Bucket(stack, 'Only', { versioning: false, publicAccess: false });
    const out = renderMermaid(buildModel('p', 'aws', 'r', [{ name: 'solo', stack }]));

    expect(out).toContain('solo_Only');
    expect(out).not.toContain('-.->');
    expect(out).not.toContain('Setas tracejadas indicam');
  });
});

describe('renderStructurizr — serialização DSL', () => {
  function awsModel(): DiagramModel {
    const stack = new Stack('main');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
    return buildModel('My Project', 'aws', 'us-east-1', [{ name: 'main', stack }]);
  }

  test('emite workspace, model, softwareSystem (com nome saneado) e fecha chaves', () => {
    const out = renderStructurizr(awsModel());

    expect(out).toContain('workspace "My Project" {');
    expect(out).toContain('model {');
    // sanitize("My Project") -> "My_Project"
    expect(out).toContain('My_Project = softwareSystem "My Project" "Provider: aws, Region: us-east-1" {');
    // estrutura balanceada de chaves
    const opens = (out.match(/{/g) || []).length;
    const closes = (out.match(/}/g) || []).length;
    expect(opens).toBe(closes);
  });

  test('agrupa nós por stack e cada nó vira container com tags do theme AWS', () => {
    const out = renderStructurizr(awsModel());

    expect(out).toContain('group "main" {');
    expect(out).toContain('main_Vpc = container "Vpc" "cidr: 10.0.0.0/16, maxAzs: 2" "Virtual Network" {');
    expect(out).toContain('tags "Amazon Web Services - VPC Virtual private cloud VPC"');
    expect(out).toContain('main_Assets = container "Assets" "versioning: on, private" "S3 Bucket" {');
    expect(out).toContain('tags "Amazon Web Services - Simple Storage Service"');
  });

  test('relação inferida vira "[inferred]" com tag "Inferred"; bloco styles define dashed', () => {
    const out = renderStructurizr(awsModel());
    expect(out).toContain('main_Vpc -> main_Assets "[inferred]" "" "Inferred"');
    expect(out).toContain('relationship "Inferred" {');
    expect(out).toContain('dashed true');
  });

  test('views: container view por stack com include * e autoLayout + theme AWS', () => {
    const out = renderStructurizr(awsModel());

    expect(out).toContain('views {');
    expect(out).toContain('container My_Project "mainView" "main" {');
    expect(out).toContain('include *');
    expect(out).toContain('autoLayout');
    expect(out).toContain('theme "https://static.structurizr.com/themes/amazon-web-services-2023.01.31/theme.json"');
  });

  test('relação explícita (invokes) sai como "label" simples sem [inferred]', () => {
    const stack = new Stack('api');
    new Fn.Lambda(stack, 'GetUser', { runtime: 'nodejs20', handler: 'g.handler', code: './s' });
    new Fn.ApiGateway(stack, 'Gw', {
      name: 'api',
      routes: [{ method: 'GET', path: '/u', lambdaId: 'GetUser' }],
    });
    const out = renderStructurizr(buildModel('demo', 'aws', 'r', [{ name: 'api', stack }]));
    expect(out).toContain('api_Gw -> api_GetUser "invokes"');
  });

  test('provider azure usa theme e tags de Azure', () => {
    const stack = new Stack('main');
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });
    const out = renderStructurizr(buildModel('p', 'azure', 'eastus', [{ name: 'main', stack }]));

    expect(out).toContain('tags "Microsoft Azure - Blob Block"');
    expect(out).toContain('theme "https://static.structurizr.com/themes/microsoft-azure-2023.01.24/theme.json"');
  });

  test('provider gcp usa theme e tags de GCP', () => {
    const stack = new Stack('main');
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });
    const out = renderStructurizr(buildModel('p', 'gcp', 'us-central1', [{ name: 'main', stack }]));

    expect(out).toContain('tags "Google Cloud Platform - Cloud Storage"');
    expect(out).toContain('theme "https://static.structurizr.com/themes/google-cloud-platform-v1.5/theme.json"');
  });

  test('terraform reusa o theme/tags de AWS', () => {
    const stack = new Stack('main');
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });
    const out = renderStructurizr(buildModel('p', 'terraform', 'r', [{ name: 'main', stack }]));

    expect(out).toContain('tags "Amazon Web Services - Simple Storage Service"');
    expect(out).toContain('theme "https://static.structurizr.com/themes/amazon-web-services-2023.01.31/theme.json"');
  });

  test('provider desconhecido cai no fallback AWS (theme e tags)', () => {
    const stack = new Stack('main');
    new Storage.Bucket(stack, 'Assets', { versioning: false, publicAccess: false });
    const out = renderStructurizr(buildModel('p', 'oraclecloud', 'r', [{ name: 'main', stack }]));

    expect(out).toContain('tags "Amazon Web Services - Simple Storage Service"');
    expect(out).toContain('theme "https://static.structurizr.com/themes/amazon-web-services-2023.01.31/theme.json"');
  });

  test('tipo sem tag mapeada usa fallback tags "Resource"', () => {
    const stack = new Stack('s');
    stack.addConstruct({ id: 'X', type: 'Custom.Thing', props: {} });
    const out = renderStructurizr(buildModel('p', 'aws', 'r', [{ name: 's', stack }]));
    expect(out).toContain('tags "Resource"');
  });
});

describe('escape de labels em renderers (CLI-08)', () => {
  test('renderMermaid escapa aspas duplas e colchetes em label/description', () => {
    const stack = new Stack('main');
    stack.addConstruct({
      id: 'X',
      type: 'Custom.Thing',
      props: {},
    });
    // hackeia o nó pra ter caracteres especiais
    const model = buildModel('p', 'aws', 'r', [{ name: 'main', stack }]);
    model.stacks[0].nodes[0].label = 'Has "quotes" and [brackets]';
    model.stacks[0].nodes[0].description = 'desc "with" [chars]';

    const out = renderMermaid(model);
    // dentro do bloco mermaid (sintaxe do grafo) o label tem que estar escapado
    // — caso contrário " ou [ ] quebram o parser do mermaid.
    const block = out.split('```mermaid')[1].split('```')[0];
    expect(block).toContain('&quot;');
    expect(block).toContain('&#91;');
    expect(block).toContain('&#93;');
    expect(block).toMatch(/Has &quot;quotes&quot; and &#91;brackets&#93;/);
    expect(block).not.toMatch(/Has "quotes" and \[brackets\]/);
  });

  test('renderStructurizr substitui aspas duplas em labels (mantém DSL bem-formada)', () => {
    const stack = new Stack('main');
    stack.addConstruct({ id: 'X', type: 'Custom.Thing', props: {} });
    const model = buildModel('proj "weird"', 'aws', 'r', [{ name: 'group "x"', stack }]);
    model.stacks[0].nodes[0].label = 'Name "with" quotes';
    model.stacks[0].nodes[0].description = 'desc "x"';

    const dsl = renderStructurizr(model);
    // o nome do workspace, do grupo e da label não devem quebrar as aspas externas
    // (aspa dupla interna some — vira aspa simples)
    expect(dsl).toContain("workspace \"proj 'weird'\"");
    expect(dsl).toContain("group \"group 'x'\"");
    expect(dsl).toContain("container \"Name 'with' quotes\"");
    // chaves balanceadas — DSL ainda parseável
    const opens = (dsl.match(/{/g) || []).length;
    const closes = (dsl.match(/}/g) || []).length;
    expect(opens).toBe(closes);
  });

  test('renderStructurizr remove quebras de linha de labels', () => {
    const stack = new Stack('main');
    stack.addConstruct({ id: 'X', type: 'Custom.Thing', props: {} });
    const model = buildModel('p', 'aws', 'r', [{ name: 'main', stack }]);
    model.stacks[0].nodes[0].label = 'line1\nline2';

    const dsl = renderStructurizr(model);
    expect(dsl).toContain('container "line1 line2"');
    expect(dsl).not.toMatch(/container "line1\nline2"/);
  });
});

describe('integração builder→renderers: consistência de ids entre DSL e mermaid', () => {
  test('todos os ids de nós aparecem nas duas serializações', () => {
    const stack = new Stack('main');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });
    new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
    new Database.SQL(stack, 'Db', { engine: 'postgres' });
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'h.h', code: './s' });

    const model = buildModel('demo', 'aws', 'r', [{ name: 'main', stack }]);
    const mer = renderMermaid(model);
    const dsl = renderStructurizr(model);

    for (const node of model.stacks[0].nodes) {
      expect(mer).toContain(node.id);
      expect(dsl).toContain(node.id);
    }
  });
});
