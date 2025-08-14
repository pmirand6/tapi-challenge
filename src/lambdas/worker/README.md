# Worker Lambda

Esta Lambda procesa los mensajes que llegan a **SQS FIFO** (encolados previamente por el Scheduler).  
Su función principal es **invocar dos Lambdas internas (A y B) a través de un API Gateway privado**, consolidar sus resultados y persistirlos en DynamoDB.

---

## Flujo de la función

1. **Lectura de mensajes desde SQS**
   - Cada mensaje contiene:
     - `id`: identificador del job.
     - `provider`: usado como `MessageGroupId` en la cola (garantiza orden y evita concurrencia por proveedor).
     - `endpoint`: ruta lógica a procesar.
     - `body`: payload con los datos del job.

2. **Invocación de APIs internas**
   - El Worker llama a un **API Gateway Privado** dentro de la VPC.
   - Este Gateway direcciona a las Lambdas **A** y **B**.
   - El Worker puede invocarlas:
     - **En paralelo** (por defecto, para reducir latencia).
     - **Secuencial** (si una depende de la salida de la otra).
   - Se aplican:
     - **Timeouts configurables** (`REQ_TIMEOUT_MS`).
     - **Retrys** en casos de 5xx, 429 o timeouts.

3. **Consolidación de resultados**
   - Se construye una respuesta combinada:
     - `ok`: verdadero si A y B respondieron correctamente.
     - `httpStatus`: 200 si ambas fueron exitosas, o el mayor de los códigos de error en caso de fallo.
     - `latencyMs`: tiempo total de ejecución.
     - `data`: contiene las salidas de A y B.

4. **Persistencia en DynamoDB**
   - Los resultados se guardan en la tabla `RESULTS_TABLE`.
   - Cada registro incluye:
     - `id` del job.
     - Estado (`OK` o `FAILED`).
     - Código HTTP.
     - Latencia.
     - Payload con las respuestas o error.

5. **Manejo de errores y resiliencia**
   - Si ocurre un error:
     - Se guarda un registro con `FAILED` en DynamoDB.
     - Si el error es **reintetable** (5xx, 429, timeout, etc.), la Lambda lanza la excepción:
       - Esto permite a SQS hacer retry automático y, tras agotar intentos, enviar el mensaje a la **DLQ**.
     - Si es un **error no-reintetable** (4xx), el mensaje se considera consumido para no bloquear la cola.

---

## Ejemplo de ejecución

1. Scheduler encola en SQS un mensaje:

```json
{
  "id": "rec-001",
  "provider": "provA",
  "endpoint": "/customer/process",
  "body": { "customerId": "123" }
}
```

2. Worker procesa el mensaje:
   - Llama a `/lambdaA` y `/lambdaB` vía API Gateway privado.
   - Consolida resultados en `{ ok: true, httpStatus: 200, data: { a: {...}, b: {...} } }`.

3. Inserta en DynamoDB:

```json
{
  "id": "rec-001",
  "status": "OK",
  "httpStatus": 200,
  "latencyMs": 152,
  "payload": "{ \"a\": {...}, \"b\": {...} }"
}
```

---

## Beneficios

- **Orden garantizado** por proveedor con SQS FIFO.  
- **Resiliencia** con reintentos automáticos y DLQ.  
- **Distribución de carga** gracias al Scheduler + delays.  
- **Visibilidad** de cada ejecución con resultados en DynamoDB.  
- **Flexibilidad** para invocar APIs en paralelo o secuencialmente.  

---

## Variables de entorno

- `RESULTS_TABLE` → tabla de DynamoDB donde se persisten los resultados.  
- `INTERNAL_API_URL` → endpoint del API Gateway Privado (ejemplo: `https://vpce-xxx.execute-api.us-east-1.amazonaws.com/prod`).  
- `API_KEY` → opcional, si el API Gateway usa planes de uso.  
- `REQ_TIMEOUT_MS` → timeout en milisegundos para cada request (default: `5000`).  
