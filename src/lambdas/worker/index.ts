import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const RESULTS_TABLE = process.env.RESULTS_TABLE!;

// Simulación: llamada a dos Lambdas internas
async function callInternalApis(endpoint: string, body: any) {
  // TODO: reemplazar por Lambda Invoke / API Gateway
  return { ok: true, data: { endpoint, echo: body }, httpStatus: 200, latencyMs: 50 };
}

function isRetryable(status: number, errCode?: string) {
  if (status >= 500) return true;   // 5xx
  if (status === 429) return true;  // rate limit
  if (errCode === 'TimeoutError' || errCode === 'ECONNRESET') return true;
  return false;
}

export const handler = async (event: any) => {
  const records = Array.isArray(event.Records) ? event.Records : [];
  for (const r of records) {
    const msg = JSON.parse(r.body);
    const start = Date.now();
    try {
      const resp = await callInternalApis(msg.endpoint, msg.body);
      const latency = Date.now() - start;

      await ddb.send(new PutItemCommand({
        TableName: RESULTS_TABLE,
        Item: {
          pk: { S: `RES#${msg.id}#${new Date().toISOString().slice(0,10)}` },
          sk: { S: `RES#${msg.id}` },
          id: { S: msg.id },
          status: { S: resp.ok ? 'OK' : 'FAILED' },
          httpStatus: { N: String(resp.httpStatus) },
          latencyMs: { N: String(latency) },
          payload: { S: JSON.stringify(resp.data) }
        }
      }));
    } catch (e: any) {
      const http = e?.httpStatus ?? 500;
      const code = e?.code;
      const latency = Date.now() - start;

      await ddb.send(new PutItemCommand({
        TableName: RESULTS_TABLE,
        Item: {
          pk: { S: `RES#${msg.id}#${new Date().toISOString().slice(0,10)}` },
          sk: { S: `RES#${msg.id}` },
          id: { S: msg.id },
          status: { S: 'FAILED' },
          httpStatus: { N: String(http) },
          latencyMs: { N: String(latency) },
          error: { S: JSON.stringify({ message: e?.message || 'unknown', code }) }
        }
      }));

      if (isRetryable(http, code)) {
        throw e; // reintentar via SQS redrive
      } else {
        // no retry (4xx semántico)
      }
    }
  }
  return {};
};
