import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});

const QUEUE_URL = process.env.QUEUE_URL!;
const RECORDS_TABLE = process.env.RECORDS_TABLE!;

// Compute a spread schedule over 24h for n items
function spreadDelays(n: number): number[] {
  const secondsInDay = 24 * 60 * 60;
  const delays: number[] = [];
  for (let i = 0; i < n; i++) {
    delays.push(Math.floor((i * secondsInDay) / Math.max(1, n - 1)));
  }
  return delays;
}

export const handler = async () => {
  // naive scan (in prod: use pagination + batch size)
  const scan = await ddb.send(new ScanCommand({ TableName: RECORDS_TABLE, Limit: 1000 }));
  const items = scan.Items ?? [];
  const n = items.length;

  const delays = spreadDelays(n);
  const date = new Date().toISOString().slice(0,10); // YYYY-MM-DD

  let i = 0;
  for (const it of items) {
    const provider = it['provider']?.S ?? 'default';
    const id = it['id']?.S ?? `rec-${i}`;

    // body directo (sin puntero S3) :: alcance declarado en README
    const payload = {
      id,
      provider,
      endpoint: it['endpoint']?.S,
      body: it['body']?.S ? JSON.parse(it['body'].S) : {} // parseo sincrónico
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: provider,                 // evitar concurrencia por proveedor
      MessageDeduplicationId: `${id}@${date}`,  // idempotencia por día
      DelaySeconds: Math.min(900, delays[i] % 900) // olas de 15 min
    }));

    i++;
  }

  return { enqueued: n };
};
