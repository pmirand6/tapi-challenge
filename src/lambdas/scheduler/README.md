# Scheduler Lambda

Esta Lambda se ejecuta una vez por día mediante **Step Functions**, disparada por un cron de **EventBridge**.  
Su función es **leer registros desde DynamoDB** y **enviarlos como mensajes a una cola SQS FIFO**, para que luego sean procesados por los Workers de manera controlada.

---

## Flujo de la función

1. **Lectura de registros**
    - Se hace un `Scan` sobre la tabla `RECORDS_TABLE` (hasta 1000 ítems).
    - Cada registro representa un *job* a procesar.

2. **Cálculo de retrasos (delays)**
    - Los envíos se distribuyen en las 24 horas del día para evitar que todos se procesen de golpe.
    - Cada item recibe un **delay ideal** entre 0 y 86400 segundos.
    - Como SQS solo admite `DelaySeconds ≤ 900` (15 minutos), se agrupan en ventanas de 15 minutos.
    - Se aplica un **jitter aleatorio (0–5s)** para que no caigan todos al mismo segundo.

   > **Jitter**: ruido aleatorio agregado al delay para romper la sincronización y evitar picos de tráfico.

3. **Envío a SQS FIFO**
    - Cada registro se encola en **SQS FIFO** con:
        - `MessageGroupId = provider` → asegura orden y no concurrencia por proveedor.
        - `MessageDeduplicationId = id@YYYY-MM-DD` → evita procesar un mismo registro más de una vez al día.
        - `DelaySeconds` calculado en el paso anterior.
    - El cuerpo (`MessageBody`) incluye:
        - `id`: identificador único.
        - `provider`: agrupador de jobs.
        - `endpoint`: destino a invocar por el Worker.
        - `body`: payload asociado.

4. **Respuesta**
    - Devuelve un JSON con la cantidad de mensajes encolados:
      ```json
      { "enqueued": 123 }
      ```

---

## Ejemplo

Si DynamoDB contiene estos registros:

- `provA:id1`
- `provA:id2`
- `provB:id3`

El Scheduler encolará 3 mensajes en SQS FIFO:

- Grupo `provA` → `id1@2025-08-14`, `id2@2025-08-14`
- Grupo `provB` → `id3@2025-08-14`

Los Workers consumirán estos mensajes en orden, distribuidos en el tiempo.

---

## Beneficios

- **Carga distribuida** → evita picos de tráfico.
- **Orden garantizado por proveedor** con SQS FIFO.
- **Idempotencia diaria** → no se procesan registros duplicados en el mismo día.
- **Resiliencia** → mensajes fallidos se envían a la **DLQ** y pueden reprocesarse.
