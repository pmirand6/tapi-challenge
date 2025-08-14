import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';

export class TapiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB tables
    const records = new dynamodb.Table(this, 'RecordsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const results = new dynamodb.Table(this, 'ResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // SQS FIFO queue + DLQ
    const dlq = new sqs.Queue(this, 'DLQ', {
      fifo: true,
      contentBasedDeduplication: true,
      queueName: 'tapi-dlq.fifo'
    });

    const queue = new sqs.Queue(this, 'JobsQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      visibilityTimeout: cdk.Duration.seconds(120),
      queueName: 'tapi-jobs.fifo'
    });

    // Lambda: Worker
    const worker = new lambda.Function(this, 'WorkerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambdas/worker')),
      timeout: cdk.Duration.seconds(60),
      environment: {
        RESULTS_TABLE: results.tableName,
      }
    });
    queue.grantConsumeMessages(worker);
    results.grantReadWriteData(worker);

    // Lambda: Scheduler (enqueue)
    const scheduler = new lambda.Function(this, 'SchedulerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambdas/scheduler')),
      timeout: cdk.Duration.seconds(60),
      environment: {
        QUEUE_URL: queue.queueUrl,
        RECORDS_TABLE: records.tableName
      }
    });
    queue.grantSendMessages(scheduler);
    records.grantReadData(scheduler);

    // Step Functions: simple map over batches -> invoke scheduler lambda repeatedly
    const scheduleTask = new tasks.LambdaInvoke(this, 'EnqueueBatch', {
      lambdaFunction: scheduler,
      payloadResponseOnly: true
    });

    const definition = new sfn.Map(this, 'ForEachBatch', {
      maxConcurrency: 1 // batches en serie; scheduler aplica delays internos
    }).iterator(scheduleTask);

    const stateMachine = new sfn.StateMachine(this, 'DailySchedulerSM', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2)
    });

    // EventBridge rule para disparo diario
    new events.Rule(this, 'DailyTrigger', {
      schedule: events.Schedule.cron({ minute: '0', hour: '0' }), // 00:00 UTC diario
      targets: [new targets.SfnStateMachine(stateMachine)]
    });

    // Permisos de invocación
    stateMachine.grantStartExecution(new iam.AccountRootPrincipal());
  }
}
