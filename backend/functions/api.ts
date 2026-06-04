import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface Resource {
  id: string;
  type: string;
  name: string;
  category?: string;
  specification?: string;
  unit: string;
  standardCost?: number;
  standardPrice?: number;
  leadTime?: number;
  safetyStock?: number;
  isActive: boolean;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface Process {
  id: string;
  code: string;
  name: string;
  category: string;
  standardWorkTime?: number;
  setupTime?: number;
  workLocation?: string;
  requiredSkill?: string;
  qualityStandard?: string;
  isActive: boolean;
  displayOrder?: number;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface ProductionOrder {
  id: string;
  orderNumber: string;
  productId: string;
  quantity: number;
  plannedCompletionDate: string;
  plannedStartDate: string;
  priority: number;
  status: string;
  actualQuantity?: number;
  actualStartDate?: string;
  actualCompletionDate?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface ProductionOrderProcess {
  id: string;
  productionOrderId: string;
  processId: string;
  sequence: number;
  plannedStartDate: string;
  plannedEndDate: string;
  actualStartDate?: string;
  actualEndDate?: string;
  status: string;
  plannedQuantity: number;
  actualQuantity?: number;
  defectQuantity?: number;
  assigneeId?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface WorkResult {
  id: string;
  productionOrderProcessId: string;
  workStartDate: string;
  workEndDate?: string;
  workerId: string;
  actualQuantity: number;
  defectQuantity?: number;
  status: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface QualityCheckResult {
  id: string;
  productionOrderProcessId: string;
  productId: string;
  processId: string;
  checkItemName: string;
  standardValue?: string;
  actualValue?: string;
  result: string;
  defectContent?: string;
  checkQuantity: number;
  passQuantity: number;
  failQuantity: number;
  checkDate: string;
  checker: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface WorkLog {
  id: string;
  productionOrderProcessId: string;
  workerId: string;
  workStartDate: string;
  workEndDate?: string;
  workContent: string;
  workDetail?: string;
  processedQuantity?: number;
  equipmentId?: string;
  hasAbnormality: boolean;
  abnormalityContent?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface ProcessHandover {
  id: string;
  productionOrderId: string;
  fromProcessId: string;
  toProcessId: string;
  handoverQuantity: number;
  handoverDate: string;
  handoverId: string;
  receiverId?: string;
  handoverContent?: string;
  qualityStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

function getUserRole(event: APIGatewayProxyEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'];
  if (!role) {
    throw new Error('Missing user role');
  }
  return validateRole(role);
}

function getUserId(event: APIGatewayProxyEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'system';
}

async function createAuditLog(action: string, details: any, userId: string): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    details,
    userId,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return createResponse(statusCode, { error: message });
}

async function getResources(): Promise<Resource[]> {
  const result = await docClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'attribute_exists(#type) AND #type = :type',
    ExpressionAttributeNames: {
      '#type': 'type'
    },
    ExpressionAttributeValues: {
      ':type': 'PRODUCT'
    }
  }));
  
  return (result.Items || []) as Resource[];
}

async function bulkImport(tableIndex: string, items: Record<string, unknown>[], userId: string): Promise<{ imported: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;
  
  const typeMap: Record<string, string> = {
    '0': 'PRODUCT',
    '1': 'PROCESS', 
    '2': 'PRODUCTION_ORDER',
    '3': 'PRODUCTION_ORDER_PROCESS',
    '4': 'WORK_RESULT',
    '5': 'QUALITY_CHECK_RESULT',
    '6': 'WORK_LOG',
    '7': 'PROCESS_HANDOVER'
  };
  
  const itemType = typeMap[tableIndex];
  if (!itemType) {
    throw new Error('Invalid table index');
  }
  
  const now = new Date().toISOString();
  const processedItems = items.map(item => ({
    ...item,
    id: item.id || randomUUID(),
    type: itemType,
    createdAt: item.createdAt || now,
    updatedAt: now,
    createdBy: item.createdBy || userId,
    updatedBy: userId
  }));
  
  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < processedItems.length; i += 25) {
    const batch = processedItems.slice(i, i + 25);
    
    try {
      const writeRequests = batch.map(item => ({
        PutRequest: {
          Item: item
        }
      }));
      
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: writeRequests
        }
      }));
      
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  await createAuditLog('BULK_IMPORT', {
    tableIndex,
    itemType,
    totalItems: items.length,
    imported,
    failed
  }, userId);
  
  return { imported, failed, errors };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const path = event.path;
    const method = event.httpMethod;
    
    let userRole: Role;
    let userId: string;
    
    try {
      userRole = getUserRole(event);
      userId = getUserId(event);
    } catch (error) {
      return createErrorResponse(403, 'Authentication required');
    }
    
    // Handle bulk import endpoints
    const bulkImportMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkImportMatch && method === 'POST') {
      if (!hasPermission(userRole, 'write')) {
        return createErrorResponse(403, 'Insufficient permissions');
      }
      
      const tableIndex = bulkImportMatch[1];
      
      try {
        const body = JSON.parse(event.body || '{}');
        if (!body.items || !Array.isArray(body.items)) {
          return createErrorResponse(400, 'Invalid request body. Expected { items: Array }');
        }
        
        const result = await bulkImport(tableIndex, body.items, userId);
        return createResponse(200, result);
      } catch (error) {
        return createErrorResponse(400, error instanceof Error ? error.message : 'Invalid request');
      }
    }
    
    // Handle GET /resources
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'read')) {
        return createErrorResponse(403, 'Insufficient permissions');
      }
      
      try {
        const resources = await getResources();
        return createResponse(200, resources);
      } catch (error) {
        return createErrorResponse(500, 'Internal server error');
      }
    }
    
    return createErrorResponse(404, 'Endpoint not found');
    
  } catch (error) {
    console.error('Handler error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};