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

const TABLES = {
  '0': { name: 'products', pk: 'PRODUCT' },
  '1': { name: 'processes', pk: 'PROCESS' },
  '2': { name: 'production_orders', pk: 'PRODUCTION_ORDER' },
  '3': { name: 'production_order_processes', pk: 'PRODUCTION_ORDER_PROCESS' },
  '4': { name: 'work_results', pk: 'WORK_RESULT' },
  '5': { name: 'quality_check_results', pk: 'QUALITY_CHECK_RESULT' },
  '6': { name: 'work_logs', pk: 'WORK_LOG' },
  '7': { name: 'process_handover_info', pk: 'PROCESS_HANDOVER_INFO' }
};

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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
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

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :pk)',
      ExpressionAttributeValues: {
        ':pk': 'PRODUCT'
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'items array is required' });
  }

  const items = requestBody.items;
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = batch.map(item => {
      const now = new Date().toISOString();
      const processedItem = {
        ...item,
        pk: table.pk,
        sk: item.id || randomUUID(),
        id: item.id || randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: user.id,
        updatedBy: user.id
      };

      return {
        PutRequest: {
          Item: processedItem
        }
      };
    });

    try {
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: writeRequests
        }
      }));
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
    }
  }

  // Create audit log
  await createAuditLog(user, 'BULK_IMPORT', table.name, {
    tableIndex,
    totalItems: items.length,
    imported,
    failed
  });

  return createResponse(200, {
    imported,
    failed,
    errors
  });
}

async function handleGetItem(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'item', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: table.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateItem(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'item', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const item = {
    ...requestBody,
    pk: table.pk,
    sk: id,
    id,
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user, 'CREATE', table.name, { id });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateItem(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'item', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const now = new Date().toISOString();
  const updateExpression = 'SET updatedAt = :updatedAt, updatedBy = :updatedBy';
  const expressionAttributeValues: any = {
    ':updatedAt': now,
    ':updatedBy': user.id
  };

  // Add other fields to update
  Object.keys(requestBody).forEach((key, index) => {
    if (key !== 'pk' && key !== 'sk' && key !== 'id' && key !== 'createdAt' && key !== 'createdBy') {
      const placeholder = `:val${index}`;
      updateExpression += `, ${key} = ${placeholder}`;
      expressionAttributeValues[placeholder] = requestBody[key];
    }
  });

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: table.pk,
        sk: id
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await createAuditLog(user, 'UPDATE', table.name, { id });

    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteItem(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'item', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: table.pk,
        sk: id
      }
    }));

    await createAuditLog(user, 'DELETE', table.name, { id });

    return createResponse(204, {});
  } catch (error) {
    console.error('Error deleting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleListItems(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'item', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const table = TABLES[tableIndex as keyof typeof TABLES];
  if (!table) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': table.pk
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error listing items:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  let user: User;
  try {
    user = extractUserFromEvent(event);
  } catch (error) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const path = event.path;
  const method = event.httpMethod;

  try {
    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      return await handleGetResources(event, user);
    }

    // Handle table-specific endpoints
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const action = tableMatch[2];
      const itemId = tableMatch[3];

      // Bulk import endpoint
      if (action === 'bulk' && method === 'POST') {
        return await handleBulkImport(event, user, tableIndex);
      }

      // CRUD endpoints
      if (!action) {
        // List items
        if (method === 'GET') {
          return await handleListItems(event, user, tableIndex);
        }
        // Create item
        if (method === 'POST') {
          return await handleCreateItem(event, user, tableIndex);
        }
      } else if (action && !itemId) {
        // Get item by ID
        if (method === 'GET') {
          event.pathParameters = { id: action };
          return await handleGetItem(event, user, tableIndex);
        }
        // Update item by ID
        if (method === 'PUT') {
          event.pathParameters = { id: action };
          return await handleUpdateItem(event, user, tableIndex);
        }
        // Delete item by ID
        if (method === 'DELETE') {
          event.pathParameters = { id: action };
          return await handleDeleteItem(event, user, tableIndex);
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};