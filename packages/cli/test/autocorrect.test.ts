import { buildAzureSdkCorrection } from '../src/generation/autocorrect';

// stack de projeto DynamoDB (Cosmos Table API no Azure)
const dynamoStack = { path: 'stacks/database/db-stack.ts', content: `new Database.DynamoDB(stack, 'ItemsTable', {})` };
const sqlStack = { path: 'stacks/database/db-stack.ts', content: `new Database.SQL(stack, 'AppDB', { engine: 'postgres' })` };

describe('buildAzureSdkCorrection — shim de DynamoDB SDK no Azure', () => {
  test('handler com @aws-sdk/client-dynamodb + lib-dynamodb num projeto DynamoDB → NÃO corrige (shim cobre)', () => {
    const files = [
      dynamoStack,
      { path: 'src/createItem.ts', content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';` },
    ];
    // deploy-validado TESTE12: esses handlers rodam no Azure via azure-dynamo-shim
    expect(buildAzureSdkCorrection(files)).toBeNull();
  });

  test('handler com @aws-sdk/client-s3 (não-shimmado) → corrige', () => {
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
    // num projeto SQL o SDK certo é pg — o dynamo SDK é shimmado p/ Tables, errado aqui
    const msg = buildAzureSdkCorrection(files);
    expect(msg).not.toBeNull();
  });

  test('handler 100% Azure SDK → não corrige', () => {
    const files = [
      dynamoStack,
      { path: 'src/get.ts', content: `import { TableClient } from '@azure/data-tables';` },
    ];
    expect(buildAzureSdkCorrection(files)).toBeNull();
  });
});
