import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});

const QUEUE_URL = process.env.QUEUE_URL!;
const RECORDS_TABLE = process.env.RECORDS_TABLE!;

/**
 * Distribuye N elementos a lo largo de 24h en segundos [0..86400).
 * NOTA: luego mapeamos esa distribución a ventanas de 15 minutos (<= 900s) por la limitación de SQS.
 */
function spreadDelays(n: number): number[] {
    const secondsInDay = 24 * 60 * 60; // 86400
    const delays: number[] = [];
    for (let i = 0; i < Math.max(1, n); i++) {
        // ejemplo simple: espaciado lineal a lo largo del día
        delays.push(Math.floor((i * secondsInDay) / Math.max(1, n - 1)));
    }
    return delays;
}

/** Pequeño jitter en segundos para evitar que muchos mensajes caigan en el mismo segundo */
function smallJitter(maxSeconds = 5): number {
    return Math.floor(Math.random() * (maxSeconds + 1)); // [0..max]
}

export const handler = async () => {
    // Escaneo simple (challenge): hasta 1000 registros
    const scan = await ddb.send(new ScanCommand({ TableName: RECORDS_TABLE, Limit: 1000 }));
    const items = scan.Items ?? [];
    const n = items.length;

    // Distribución base a lo largo de 24h
    const baseDelays = spreadDelays(n);
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let i = 0;
    for (const it of items) {
        const provider = it['provider']?.S ?? 'default';
        const id = it['id']?.S ?? `rec-${i}`;
        const endpoint = it['endpoint']?.S ?? '/';
        const body = it['body']?.S ? JSON.parse(it['body'].S) : {};

        // 1) delay "ideal" en el día
        const ideal = baseDelays[i] || 0;

        // 2) SQS limita DelaySeconds <= 900 (15 min).
        //    Mapeamos el ideal a la ventana actual de 15 min (usando módulo)
        //    y agregamos un pequeño jitter para evitar que todos caigan en el mismo segundo.
        const delaySeconds = Math.min(900, (ideal % 900) + smallJitter(5));

        // Mensaje a SQS FIFO
        const payload = { id, provider, endpoint, body };
        await sqs.send(new SendMessageCommand({
            QueueUrl: QUEUE_URL,
            MessageBody: JSON.stringify(payload),
            MessageGroupId: provider,                // evita concurrencia por proveedor
            MessageDeduplicationId: `${id}@${date}`, // idempotencia por día
            DelaySeconds: delaySeconds               // siempre <= 900
        }));

        i++;
    }

    return { enqueued: n };
};
