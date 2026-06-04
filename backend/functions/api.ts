import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const tableConfigs = {
  products: { pk: 'PRODUCT', name: '製品マスタ' },
  processes: { pk: 'PROCESS', name: '工程マスタ' },
  production_orders: { pk: 'PRODUCTION_ORDER', name: '生産指示書' },
  production_processes: { pk: 'PRODUCTION_PROCESS', name: '生産指示工程' },
  work_results: { pk: 'WORK_RESULT', name: '作業実績' },
  quality_checks: { pk: 'QUALITY_CHECK', name: '品質チェック結果' },
  work_logs: { pk: 'WORK_LOG', name: '作業ログ' },
  process_handovers: { pk: 'PROCESS_HANDOVER', name: '工程引継ぎ情報' }
};

type TableKey = keyof typeof tableConfigs;

function createResponse(statusCode: number, body: any): APIResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function getTableConfig(path: string): { tableKey: TableKey; config: typeof tableConfigs[TableKey] } | null {
  const pathParts = path.split('/');
  if (pathParts.length < 2) return null;
  
  const tableKey = pathParts[1] as TableKey;
  const config = tableConfigs[tableKey];
  
  return config ? { tableKey, config } : null;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function addId(item: any, pk: string): any {
  if (!item.id) {
    item.id = randomUUID();
  }
  item.pk = pk;
  item.sk = item.id;
  return item;
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const { items } = requestBody;
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = [];

    for (const item of batch) {
      try {
        const processedItem = addTimestamps(addId({ ...item }, config.pk));
        writeRequests.push({
          PutRequest: {
            Item: processedItem
          }
        });
      } catch (error) {
        failed++;
        errors.push(`Item ${i + writeRequests.length}: ${error}`);
      }
    }

    if (writeRequests.length > 0) {
      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        }));
        imported += writeRequests.length;
      } catch (error) {
        failed += writeRequests.length;
        errors.push(`Batch ${Math.floor(i / 25)}: ${error}`);
      }
    }
  }

  await createAuditLog(user, 'BULK_IMPORT', tableKey, { imported, failed, total: items.length });

  return createResponse(200, { imported, failed, errors });
}

async function handleList(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    }));

    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreate(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  // Basic validation - add specific validation per table as needed
  const requiredFields = ['name']; // Simplified - should be table-specific
  const validationErrors = validateRequired(requestBody, requiredFields);
  if (validationErrors.length > 0) {
    return createResponse(400, { error: 'Validation failed', details: validationErrors });
  }

  try {
    const item = addTimestamps(addId({ ...requestBody, createdBy: user.id, updatedBy: user.id }, config.pk));
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user, 'CREATE', tableKey, { id: item.id });

    return createResponse(201, item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdate(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  try {
    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existing.Item,
      ...requestBody,
      updatedBy: user.id,
      updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog(user, 'UPDATE', tableKey, { id });

    return createResponse(200, updatedItem);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDelete(event: APIGatewayEvent, user: User, tableKey: TableKey, config: typeof tableConfigs[TableKey]): Promise<APIResponse> {
  if (!hasPermission(user, tableKey, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    await createAuditLog(user, 'DELETE', tableKey, { id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleResources(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = [];
    
    // Get all table data
    for (const [key, config] of Object.entries(tableConfigs)) {
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': config.pk
        }
      }));
      
      resources.push({
        type: key,
        name: config.name,
        count: result.Items?.length || 0,
        items: result.Items || []
      });
    }

    return createResponse(200, { resources });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const method = event.httpMethod;
    const path = event.path;

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      return await handleResources(event, user);
    }

    // Handle table-specific endpoints
    const tableInfo = getTableConfig(path);
    if (!tableInfo) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const { tableKey, config } = tableInfo;
    const pathParts = path.split('/');

    // Handle bulk import: POST /api/{table}/bulk
    if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
      return await handleBulkImport(event, user, tableKey, config);
    }

    // Handle CRUD operations
    if (pathParts.length === 2) {
      // Collection endpoints: /api/{table}
      switch (method) {
        case 'GET':
          return await handleList(event, user, tableKey, config);
        case 'POST':
          return await handleCreate(event, user, tableKey, config);
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    } else if (pathParts.length === 3) {
      // Item endpoints: /api/{table}/{id}
      switch (method) {
        case 'GET':
          return await handleGet(event, user, tableKey, config);
        case 'PUT':
          return await handleUpdate(event, user, tableKey, config);
        case 'DELETE':
          return await handleDelete(event, user, tableKey, config);
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Resource not found' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}