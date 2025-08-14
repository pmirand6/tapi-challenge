import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as path from "path";

export class TapiStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ===========
        // VPC privada
        // ===========
        const vpc = new ec2.Vpc(this, "AppVpc", {
            maxAzs: 2,
            natGateways: 0, // no NAT (usamos VPC endpoints)
            subnetConfiguration: [
                { name: "private", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            ],
        });

        // ============================
        // KMS keys (SQS / DynamoDB / S3)
        // ============================
        const kmsKey = new kms.Key(this, "DataKey", {
            enableKeyRotation: true,
            description: "CMK for SQS/DynamoDB (and S3 if used)",
        });

        // ============================
        // DynamoDB (Results) con KMS
        // ============================
        const results = new dynamodb.Table(this, "ResultsTable", {
            partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: kmsKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // demo/challenge
        });

        // (Opcional) Tabla Records si la usás para semilla/scheduler
        const records = new dynamodb.Table(this, "RecordsTable", {
            partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: kmsKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ============================
        // SQS FIFO + DLQ con KMS
        // ============================
        const dlq = new sqs.Queue(this, "Dlq", {
            fifo: true,
            contentBasedDeduplication: true,
            queueName: "tapi-dlq.fifo",
            encryptionMasterKey: kmsKey,
        });

        const jobs = new sqs.Queue(this, "JobsQueue", {
            fifo: true,
            contentBasedDeduplication: true,
            deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
            visibilityTimeout: cdk.Duration.seconds(120),
            queueName: "tapi-jobs.fifo",
            encryptionMasterKey: kmsKey,
        });

        // ============================
        // VPC Endpoints (según diagrama)
        // - execute-api (API GW privado)
        // - logs (CloudWatch)
        // - sqs (SQS)
        // - dynamodb (Gateway)
        // - s3 (Gateway) [opcional data lake]
        // ============================
        const sgVpcEndpoints = new ec2.SecurityGroup(this, "VpcEpSG", {
            vpc,
            description: "SG for VPC interface endpoints",
            allowAllOutbound: true,
        });

        // Interface endpoints
        vpc.addInterfaceEndpoint("ExecuteApiVpce", {
            service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
            securityGroups: [sgVpcEndpoints],
            subnets: { subnets: vpc.privateSubnets },
            // privateDnsEnabled: true, // si querés usar nombres *.execute-api dentro de VPC
        });

        vpc.addInterfaceEndpoint("SqsVpce", {
            service: ec2.InterfaceVpcEndpointAwsService.SQS,
            securityGroups: [sgVpcEndpoints],
            subnets: { subnets: vpc.privateSubnets },
        });

        vpc.addInterfaceEndpoint("LogsVpce", {
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            securityGroups: [sgVpcEndpoints],
            subnets: { subnets: vpc.privateSubnets },
        });

        // Gateway endpoints
        vpc.addGatewayEndpoint("DynamoDbGw", {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
            // routeTables inferidas por subnets privadas
        });

        vpc.addGatewayEndpoint("S3Gw", {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        // ============================
        // Secrets & Parameters (seguridad/config)
        // ============================
        const apiSecret = new secrets.Secret(this, "InternalApiSecret", {
            description: "Opcional: API key for private API Gateway",
            generateSecretString: { secretStringTemplate: JSON.stringify({}), generateStringKey: "apiKey", excludePunctuation: true },
        });

        const reqTimeoutParam = new ssm.StringParameter(this, "ReqTimeoutParam", {
            parameterName: "/tapi/req-timeout-ms",
            stringValue: "5000",
        });

        // ============================
        // Lambdas internas A y B
        // ============================
        const lambdaCommon = {
            runtime: lambda.Runtime.NODEJS_20_X,
            timeout: cdk.Duration.seconds(10),
            tracing: lambda.Tracing.ACTIVE, // X-Ray
            logRetention: logs.RetentionDays.ONE_WEEK,
        };

        const internalA = new lambda.Function(this, "InternalA", {
            ...lambdaCommon,
            handler: "index.handler",
            code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          // contrato simple: { ok, httpStatus, data }
          return { ok: true, httpStatus: 200, data: { aProcessed: true, echo: event } };
        };
      `),
            vpc, // si querés mantener todo en VPC
        });

        const internalB = new lambda.Function(this, "InternalB", {
            ...lambdaCommon,
            handler: "index.handler",
            code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return { ok: true, httpStatus: 200, data: { bProcessed: true, echo: event } };
        };
      `),
            vpc,
        });

        // ============================
        // API Gateway PRIVADO (REST) con rutas /lambdaA y /lambdaB -> Lambdas A/B
        // ============================
        const api = new apigw.RestApi(this, "InternalPrivateApi", {
            restApiName: "internal-private-api",
            description: "Private API in VPC for Worker -> A/B",
            endpointConfiguration: {
                types: [apigw.EndpointType.PRIVATE],
                // vpcEndpoints se asocian por policy (abajo) y el VPCE creado arriba
            },
            deployOptions: {
                tracingEnabled: true, // X-Ray
                stageName: "prod",
                loggingLevel: apigw.MethodLoggingLevel.INFO,
                dataTraceEnabled: false,
            },
            policy: new iam.PolicyDocument({
                statements: [
                    // Permitir invocación SOLO desde el Endpoint de VPC (Execute API)
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        principals: [new iam.AnyPrincipal()],
                        actions: ["execute-api:Invoke"],
                        resources: ["*"],
                        conditions: {
                            StringEquals: {
                                // Reemplazado en runtime por el VPCE real; como ejemplo:
                                // "aws:SourceVpce": "<vpce-id>"
                            }
                        }
                    })
                ]
            }),
        });

        const resA = api.root.addResource("lambdaA");
        resA.addMethod("POST", new apigw.LambdaIntegration(internalA));
        const resB = api.root.addResource("lambdaB");
        resB.addMethod("POST", new apigw.LambdaIntegration(internalB));

        // ============================
        // Lambda Worker (en VPC), consumer de SQS, llama API privada, persiste en DDB
        // ============================
        const worker = new lambda.Function(this, "WorkerFn", {
            ...lambdaCommon,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "../../src/lambdas/worker")), // usa tu código real
            timeout: cdk.Duration.seconds(60),
            vpc, // en VPC para llegar a API privada vía VPCE execute-api
            environment: {
                RESULTS_TABLE: results.tableName,
                INTERNAL_API_URL: `https://${api.restApiId}.execute-api.${this.region}.amazonaws.com/prod`, // (si usás Private DNS del VPCE)
                API_KEY: apiSecret.secretValueFromJson("apiKey").toString(), // opcional
                REQ_TIMEOUT_MS: reqTimeoutParam.stringValue,
            }
        });

        // Permisos Worker
        results.grantReadWriteData(worker);
        jobs.grantConsumeMessages(worker);
        apiSecret.grantRead(worker);

        // Event source mapping SQS -> Worker
        worker.addEventSourceMapping("JobsToWorker", {
            eventSourceArn: jobs.queueArn,
            batchSize: 5,
        });

        // ============================
        // Lambda Scheduler (fuera o dentro de VPC; no necesita API privada)
        // - Lee Records y encola mensajes en SQS con delay/dedup/groupId
        // ============================
        const scheduler = new lambda.Function(this, "SchedulerFn", {
            ...lambdaCommon,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "../../src/lambdas/scheduler")),
            timeout: cdk.Duration.seconds(60),
            environment: {
                QUEUE_URL: jobs.queueUrl,
                RECORDS_TABLE: records.tableName,
            }
        });
        jobs.grantSendMessages(scheduler);
        records.grantReadData(scheduler);

        // ============================
        // Step Functions + EventBridge (cron diario) -> Scheduler
        // ============================
        const enqueueTask = new tasks.LambdaInvoke(this, "EnqueueBatch", {
            lambdaFunction: scheduler,
            payloadResponseOnly: true,
        });

        const definition = new sfn.Map(this, "ForEachBatch", {
            maxConcurrency: 1, // waves controladas (el Scheduler calcula delaySeconds)
        }).iterator(enqueueTask);

        const stateMachine = new sfn.StateMachine(this, "DailySchedulerSM", {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.hours(2),
            tracingEnabled: true,
        });

        new events.Rule(this, "DailyTrigger", {
            schedule: events.Schedule.cron({ minute: "0", hour: "0" }), // 00:00 UTC
            targets: [new targets.SfnStateMachine(stateMachine)],
        });

        // Permitir a root iniciar la SM (demo)
        stateMachine.grantStartExecution(new iam.AccountRootPrincipal());

        // ============================
        // Permisos extra (logs, sqs, ddb) ya gestionados por grants y VPC endpoints
        // CloudWatch Logs y X-Ray están habilitados por 'tracing' y logRetention
        // ============================
    }
}