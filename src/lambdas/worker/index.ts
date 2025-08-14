/**
 * Lambda Worker
 * - Recibe mensajes desde SQS FIFO (evita concurrencia por proveedor con messageGroupId).
 * - Invoca API Gateway PRIVADO (dentro de la VPC) que frontendea dos Lambdas internas: A y B.
 * - Llama A y B en paralelo (o secuencial si lo necesitás), aplica timeouts y consolida la respuesta.
 * - Persiste resultado en DynamoDB (tabla Results).
 * - Resiliencia: retry 5xx/429/timeout (throw -> SQS redrive); no-retry 4xx (persistir FAILED y no lanzar).
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const RESULTS_TABLE = process.env.RESULTS_TABLE!;

// === Config API PRIVADA (ver CDK: RestApi PRIVATE con VPC Endpoint de execute-api)
const API_BASE = process.env.INTERNAL_API_URL!; // ej: https://vpce-abc123-xyz.execute-api.us-east-1.vpce.amazonaws.com/prod
const API_KEY = process.env.API_KEY;            // opcional (si habilitás usage plans)
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? 5000);

// ---- Helpers: timeout para fetch ----
function withTimeout<T>(p: Promise<T>, ms: number, label = "TimeoutError"): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => reject(Object.assign(new Error(label), { code: "TimeoutError" })), ms);
        p.then(
            v => { clearTimeout(id); resolve(v); },
            e => { clearTimeout(id); reject(e); }
        );
    });
}

// ---- Invocación HTTP a API Gateway privado ----
async function invokeHttp(path: string, payload: any) {
    if (!API_BASE) {
        const err: any = new Error("INTERNAL_API_URL not set");
        err.httpStatus = 500; err.code = "ConfigError";
        throw err;
    }
    const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const req = fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        },
        body: JSON.stringify(payload),
    });
    const res = await withTimeout(req, REQ_TIMEOUT_MS, "TimeoutError");
    const status = res.status;
    let json: any = {};
    try { json = await res.json(); } catch { json = {}; }

    // Se espera contrato { ok, httpStatus, data } desde Lambda A/B detrás del API
    const ok = json?.ok ?? res.ok;
    const httpStatus = typeof json?.httpStatus === "number" ? json.httpStatus : status;

    if (!ok) {
        const err: any = new Error(json?.error?.message || `HTTP ${httpStatus}`);
        err.httpStatus = httpStatus;
        err.code = json?.error?.code;
        throw err;
    }
    return { ok: true, httpStatus, data: json?.data ?? json };
}

/**
 * Lógica de negocio interna: invoca A y B vía API Gateway (paralelo)
 * - Ajusta a secuencial si B depende de la salida de A
 * - La URL y credenciales se inyectan por variables de entorno (CDK)
 */
async function callInternalApis(endpoint: string, body: any) {
    const payload = {
        correlationId: `${body?.id ?? "job"}@${new Date().toISOString().slice(0,10)}`,
        endpoint,
        body,
    };

    const start = Date.now();
    // Paralelo (reduce p95 cuando A y B no dependen entre sí)
    const [ra, rb] = await Promise.allSettled([
        invokeHttp("/lambdaA", payload),
        invokeHttp("/lambdaB", payload),
    ]);
    const latencyMs = Date.now() - start;

    const unwrap = (r: PromiseSettledResult<any>) =>
        r.status === "fulfilled"
            ? r.value
            : { ok: false, httpStatus: r.reason?.httpStatus ?? 500, error: r.reason };

    const A = unwrap(ra);
    const B = unwrap(rb);

    const ok = A.ok && B.ok;
    const httpStatus = ok ? 200 : Math.max(A.httpStatus ?? 500, B.httpStatus ?? 500);

    return {
        ok,
        httpStatus,
        latencyMs,
        data: { a: A.data ?? null, b: B.data ?? null },
    };
}

// Clasificación de errores para retry/no-retry (SQS redrive)
function isRetryable(status: number, errCode?: string) {
    if (status >= 500) return true;   // 5xx
    if (status === 429) return true;  // rate limit
    if (errCode === "TimeoutError" || errCode === "ECONNRESET") return true;
    return false;
}

export const handler = async (event: any) => {
    const records = Array.isArray(event.Records) ? event.Records : [];

    for (const r of records) {
        const msg = JSON.parse(r.body);
        const start = Date.now();

        try {
            // === Invoca A y B vía API Gateway Privado (diagrama: WK -> APIGW -> L1/L2)
            const resp = await callInternalApis(msg.endpoint, msg.body);

            // Persistencia en DynamoDB Results (diagrama: WK -> DDB)
            await ddb.send(new PutItemCommand({
                TableName: RESULTS_TABLE,
                Item: {
                    pk: { S: `RES#${msg.id}#${new Date().toISOString().slice(0,10)}` },
                    sk: { S: `RES#${msg.id}` },
                    id: { S: msg.id },
                    status: { S: resp.ok ? "OK" : "FAILED" },
                    httpStatus: { N: String(resp.httpStatus) },
                    latencyMs: { N: String(resp.latencyMs) },
                    payload: { S: JSON.stringify(resp.data) },
                }
            }));

        } catch (e: any) {
            const http = e?.httpStatus ?? 500;
            const code = e?.code;
            const latency = Date.now() - start;

            // Persistimos FAILED (y decidimos retry/no-retry abajo)
            await ddb.send(new PutItemCommand({
                TableName: RESULTS_TABLE,
                Item: {
                    pk: { S: `RES#${msg.id}#${new Date().toISOString().slice(0,10)}` },
                    sk: { S: `RES#${msg.id}` },
                    id: { S: msg.id },
                    status: { S: "FAILED" },
                    httpStatus: { N: String(http) },
                    latencyMs: { N: String(latency) },
                    error: { S: JSON.stringify({ message: e?.message || "unknown", code }) }
                }
            }));

            if (isRetryable(http, code)) {
                // Throw para que SQS reintente y eventualmente envíe a DLQ (diagrama: SQS -> DLQ)
                throw e;
            } else {
                // 4xx: no-retry; mensaje se considera consumido
            }
        }
    }
    return {};
};