import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Database.DynamoDB — deploy/destroy real na AWS', () => {
  test('tabela simples com partitionKey string — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('database', 1);
    const stackJs = `
const { Stack, Database } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('database', 1)}');
new Database.DynamoDB(stack, 'SimpleTable', {
  partitionKey: 'id',
  partitionKeyType: 'S',
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });

  test('tabela com sortKey e PAY_PER_REQUEST — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('database', 2);
    const stackJs = `
const { Stack, Database } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('database', 2)}');
new Database.DynamoDB(stack, 'TimestampTable', {
  partitionKey: 'id',
  partitionKeyType: 'S',
  sortKey: 'ts',
  sortKeyType: 'N',
  billingMode: 'PAY_PER_REQUEST',
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});

describe('Database.SQL (RDS MySQL) — deploy/destroy real na AWS', () => {
  test('MySQL db.t3.micro — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('database', 3);
    // A senha é lida de SSM automaticamente pelo synth — o parâmetro
    // /iacmp/<stackName>/db-password precisa existir na conta antes do teste.
    const stackJs = `
const { Stack, Database } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('database', 3)}');
new Database.SQL(stack, 'MysqlDB', {
  engine: 'mysql',
  instanceType: 'db.t3.micro',
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});

describe('Database.DocumentDB — deploy/destroy real na AWS', () => {
  test.skip('cluster mínimo com 1 instância — SKIP: DocumentDB não disponível em contas free tier (aurora-postgresql only)', () => {
    const stackName = e2eStackName('database', 4);
    // A senha é lida de SSM: /iacmp/<stackName>/docdb-password
    const stackJs = `
const { Stack, Database } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('database', 4)}');
new Database.DocumentDB(stack, 'DocCluster', {
  instances: 1,
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});
