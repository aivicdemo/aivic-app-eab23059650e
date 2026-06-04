import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractRoleFromEvent, Role } from './rbac';
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
  requestContext?: any;
}

interface APIGatewayResponse {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const tableConfigs = {
  '0': { pk: 'PRODUCT', name: '製品マスタ' },
  '1': { pk: 'PROCESS', name: '工程マスタ' },
  '2': { pk: 'PRODUCTION_ORDER', name: '生産指示書' },
  '3': { pk: 'PRODUCTION_PROCESS', name: '生産指示工程' },
  '4': { pk: 'WORK_RESULT', name: '作業実績' },
  '5': { pk: 'QUALITY_CHECK', name: '品質チェック結果' },
  '6': { pk: 'WORK_LOG', name: '作業ログ' },
  '7': { pk: 'PROCESS_HANDOVER', name: '工程引継ぎ情報' }
};

function createResponse(statusCode: number, body: any, headers?: { [key: string]: string }): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-role',
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function createAuditLog(action: string, tableName: string, details: any, userId?: string) {
  return {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    tableName,
    details,
    userId: userId || 'system',
    timestamp: new Date().toISOString()
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

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['製品コード', '製品名', '製品分類', '単位', '有効フラグ'],
    '1': ['工程コード', '工程名', '工程区分', '有効フラグ'],
    '2': ['生産指示書番号', '製品ID', '生産数量', '完成予定日', '生産開始予定日', '優先度', 'ステータス'],
    '3': ['生産指示書ID', '工程ID', '工程順序', '予定開始日時', '予定終了日時', '工程ステータス', '予定数量'],
    '4': ['生産指示工程ID', '作業開始日時', '作業者ID', '実績数量', '作業ステータス'],
    '5': ['生産指示工程ID', '製品ID', '工程ID', 'チェック項目名', '判定結果', 'チェック数量', '合格数量', '不合格数量', 'チェック実施日時', 'チェック担当者'],
    '6': ['生産指示工程ID', '作業者ID', '作業開始日時', '作業内容', '異常フラグ'],
    '7': ['生産指示書ID', '前工程ID', '次工程ID', '引継ぎ数量', '引継ぎ日時', '引継ぎ者ID', '品質状態', '引継ぎ状態']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    const role = extractRoleFromEvent(event);
    const method = event.httpMethod;
    const path = event.path;

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = [];
        for (const [index, config] of Object.entries(tableConfigs)) {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            },
            Limit: 10
          });
          
          const result = await docClient.send(command);
          resources.push({
            tableIndex: index,
            tableName: config.name,
            pk: config.pk,
            count: result.Count || 0,
            items: result.Items || []
          });
        }

        return createResponse(200, { resources });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && method === 'POST') {
      const tableIndex = bulkMatch[1];
      const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!hasPermission(role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      let requestData;
      try {
        requestData = JSON.parse(event.body);
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      if (!requestData.items || !Array.isArray(requestData.items)) {
        return createResponse(400, { error: 'items array is required' });
      }

      const requiredFields = getRequiredFields(tableIndex);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const userId = event.requestContext?.authorizer?.userId || 'system';
      const now = new Date().toISOString();

      const chunks = [];
      for (let i = 0; i < requestData.items.length; i += 25) {
        chunks.push(requestData.items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = [];
        
        for (const item of chunk) {
          const validationErrors = validateRequired(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const id = item.id || randomUUID();
          const processedItem = {
            ...item,
            pk: config.pk,
            sk: id,
            id,
            createdAt: now,
            updatedAt: now,
            作成者: userId,
            更新者: userId
          };

          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        }

        if (writeRequests.length > 0) {
          try {
            const batchCommand = new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            });
            
            await docClient.send(batchCommand);
            imported += writeRequests.length;
          } catch (error) {
            console.error('Batch write error:', error);
            failed += writeRequests.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
      }

      const auditLog = createAuditLog('BULK_IMPORT', config.name, {
        imported,
        failed,
        totalItems: requestData.items.length
      }, userId);
      
      try {
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: auditLog
        }));
      } catch (error) {
        console.error('Audit log error:', error);
      }

      return createResponse(200, { imported, failed, errors });
    }

    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (apiMatch) {
      const tableIndex = apiMatch[1];
      const itemId = apiMatch[2];
      const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (method === 'GET') {
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          try {
            const command = new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: config.pk,
                sk: itemId
              }
            });
            
            const result = await docClient.send(command);
            
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, result.Item);
          } catch (error) {
            console.error('Get item error:', error);
            return createResponse(500, { error: 'Internal server error' });
          }
        } else {
          try {
            const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
            const command = new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.pk
              },
              Limit: Math.min(limit, 100)
            });
            
            const result = await docClient.send(command);
            
            return createResponse(200, {
              items: result.Items || [],
              count: result.Count || 0,
              lastEvaluatedKey: result.LastEvaluatedKey
            });
          } catch (error) {
            console.error('Scan error:', error);
            return createResponse(500, { error: 'Internal server error' });
          }
        }
      }

      if (method === 'POST') {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        let requestData;
        try {
          requestData = JSON.parse(event.body);
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        const requiredFields = getRequiredFields(tableIndex);
        const validationErrors = validateRequired(requestData, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const id = requestData.id || randomUUID();
        const userId = event.requestContext?.authorizer?.userId || 'system';
        const now = new Date().toISOString();
        
        const item = {
          ...requestData,
          pk: config.pk,
          sk: id,
          id,
          createdAt: now,
          updatedAt: now,
          作成者: userId,
          更新者: userId
        };

        try {
          const command = new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          });
          
          await docClient.send(command);

          const auditLog = createAuditLog('CREATE', config.name, { id }, userId);
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: auditLog
          }));
          
          return createResponse(201, item);
        } catch (error) {
          console.error('Create item error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'PUT' && itemId) {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        let requestData;
        try {
          requestData = JSON.parse(event.body);
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        try {
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const userId = event.requestContext?.authorizer?.userId || 'system';
          const updatedItem = {
            ...existingItem.Item,
            ...requestData,
            pk: config.pk,
            sk: itemId,
            id: itemId,
            updatedAt: new Date().toISOString(),
            更新者: userId
          };

          const putCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          });
          
          await docClient.send(putCommand);

          const auditLog = createAuditLog('UPDATE', config.name, { id: itemId }, userId);
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: auditLog
          }));
          
          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Update item error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'DELETE' && itemId) {
        if (!hasPermission(role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const deleteCommand = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          await docClient.send(deleteCommand);

          const userId = event.requestContext?.authorizer?.userId || 'system';
          const auditLog = createAuditLog('DELETE', config.name, { id: itemId }, userId);
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: auditLog
          }));
          
          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Delete item error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};