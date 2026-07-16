import { buildAzureSdkCorrection, buildAzureTablesHelperCorrection } from '../src/generation/autocorrect';

// stack de projeto DynamoDB (Cosmos Table API no Azure)
const dynamoStack = { path: 'stacks/database/db-stack.ts', content: `new Database.DynamoDB(stack, 'ItemsTable', {})` };
const sqlStack = { path: 'stacks/database/db-stack.ts', content: `new Database.SQL(stack, 'AppDB', { engine: 'postgres' })` };

describe('buildAzureTablesHelperCorrection — força handlers a usarem ./tables', () => {
  const helper = { path: 'src/tables.ts', content: "import { table } from '@azure/data-tables';" };

  test('handler com TableClient cru → corrige (aponta o arquivo)', () => {
    const files = [
      dynamoStack, helper,
      { path: 'src/get.ts', content: "import { TableClient } from '@azure/data-tables';\nconst c = TableClient.fromConnectionString(x, y);" },
    ];
    const msg = buildAzureTablesHelperCorrection(files);
    expect(msg).not.toBeNull();
    expect(msg).toContain('src/get.ts');
    expect(msg).toContain("./tables");
  });

  test('handlers que já usam ./tables → NÃO corrige', () => {
    const files = [
      dynamoStack, helper,
      { path: 'src/get.ts', content: "import { table } from './tables';\nconst items = table('items');" },
    ];
    expect(buildAzureTablesHelperCorrection(files)).toBeNull();
  });

  test('o próprio src/tables.ts não é acusado (é ele quem usa data-tables)', () => {
    const files = [
      dynamoStack, helper,
      { path: 'src/get.ts', content: "import { table } from './tables';" },
    ];
    expect(buildAzureTablesHelperCorrection(files)).toBeNull();
  });

  test('projeto sem Database.DynamoDB → não se aplica', () => {
    const files = [
      sqlStack,
      { path: 'src/get.ts', content: "import { TableClient } from '@azure/data-tables';" },
    ];
    expect(buildAzureTablesHelperCorrection(files)).toBeNull();
  });
});

describe('buildAzureSdkCorrection — dois mundos separados (ZERO @aws-sdk no Azure)', () => {
  test('handler com @aws-sdk/client-dynamodb + lib-dynamodb → CORRIGE (dois mundos: usa ./tables, não shim)', () => {
    const files = [
      dynamoStack,
      { path: 'src/createItem.ts', content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';` },
    ];
    // regra do usuário: Azure é Azure, nenhum @aws-sdk — o caminho é o helper ./tables
    const msg = buildAzureSdkCorrection(files);
    expect(msg).not.toBeNull();
    expect(msg).toContain('src/createItem.ts');
  });

  test('handler com @aws-sdk/client-s3 → corrige', () => {
    const files = [
      dynamoStack,
      { path: 'src/upload.ts', content: `import { S3Client } from '@aws-sdk/client-s3';` },
    ];
    const msg = buildAzureSdkCorrection(files);
    expect(msg).not.toBeNull();
    expect(msg).toContain('src/upload.ts');
  });

  test('handler com @aws-sdk/client-dynamodb num projeto SQL → corrige (deveria usar pg)', () => {
    const files = [
      sqlStack,
      { path: 'src/list.ts', content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';` },
    ];
    const msg = buildAzureSdkCorrection(files);
    expect(msg).not.toBeNull();
  });

  test('handler com @aws-sdk/client-dynamodb SEM Database.DynamoDB (tabela fantasma) → corrige', () => {
    // caso sc3az (sqs-worker): o modelo gravava em DynamoDB sem declarar a tabela
    const files = [
      { path: 'stacks/messaging/q.ts', content: `new Messaging.Queue(stack, 'TaskQueue', {})` },
      { path: 'src/proc.ts', content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';` },
    ];
    expect(buildAzureSdkCorrection(files)).not.toBeNull();
  });

  test('handler 100% Azure SDK → não corrige', () => {
    const files = [
      dynamoStack,
      { path: 'src/get.ts', content: `import { TableClient } from '@azure/data-tables';` },
    ];
    expect(buildAzureSdkCorrection(files)).toBeNull();
  });
});
