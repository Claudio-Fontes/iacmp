import { buildAzureSdkCorrection } from '../src/generation/autocorrect';

// stack de projeto DynamoDB (Cosmos DB MongoDB API no Azure — NÃO Table API)
const dynamoStack = { path: 'stacks/database/db-stack.ts', content: `new Database.DynamoDB(stack, 'ItemsTable', {})` };
const sqlStack = { path: 'stacks/database/db-stack.ts', content: `new Database.SQL(stack, 'AppDB', { engine: 'postgres' })` };

describe('buildAzureSdkCorrection — dois mundos separados (ZERO @aws-sdk no Azure)', () => {
  test('handler com @aws-sdk/client-dynamodb + lib-dynamodb → CORRIGE (dois mundos: usa mongodb, não shim)', () => {
    const files = [
      dynamoStack,
      { path: 'src/createItem.ts', content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';` },
    ];
    // regra do usuário: Azure é Azure, nenhum @aws-sdk — o caminho é o driver mongodb
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

  test('handler com @azure/data-tables/TableClient num projeto DynamoDB → corrige (Table API não existe mais no Azure)', () => {
    const files = [
      dynamoStack,
      { path: 'src/get.ts', content: `import { TableClient } from '@azure/data-tables';\nconst c = TableClient.fromConnectionString(x, y);` },
    ];
    const msg = buildAzureSdkCorrection(files);
    expect(msg).not.toBeNull();
    expect(msg).toContain('src/get.ts');
    expect(msg).toContain('mongodb');
  });

  test('handler 100% Azure SDK (mongodb) → não corrige', () => {
    const files = [
      dynamoStack,
      { path: 'src/get.ts', content: `import { MongoClient } from 'mongodb';\nconst client = new MongoClient(process.env.MONGO_URI!);` },
    ];
    expect(buildAzureSdkCorrection(files)).toBeNull();
  });
});
