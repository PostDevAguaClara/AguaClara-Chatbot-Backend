import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";

import { Construct } from 'constructs';
import { KnowledgeBase } from '../constructs/knowledge-base';

export class AguaclaraChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // == Document Knowledgebase
    const kb = new KnowledgeBase(this, 'Knowledgebase');

    // == SQS Queues
    const driveSyncQueue = new sqs.Queue(this, "DriveSyncQueue", {
      visibilityTimeout: cdk.Duration.minutes(15),
    });

    // == Lambdas
    // Reciver
    const receiverLambda = new lambda.Function(this, 'GoogleDriveReceiverLambda', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'googleDriveReceiver.handler',
        code: lambda.Code.fromAsset('lambda'),
        environment: {
          QUEUE_URL: driveSyncQueue.queueUrl
        },
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
    });
    driveSyncQueue.grantSendMessages(receiverLambda);

    // Sync
    const syncLambda = new lambda.Function(this, 'GoogleDriveSyncLambda', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'googleDriveSync.handler',
        code: lambda.Code.fromAsset('lambda'),
        environment: {
          KNOWLEDGEBASE_ID: kb.knowledgeBaseId,
          KNOWLEDGEBASE_SOURCE_ID: kb.dataSourceId,
        },
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
        reservedConcurrentExecutions: 1,
    });
    syncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/chatbot/drive/*`
        ]
      })
    );
    syncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "UpdateBedrockDocuments",
        actions: [
          "bedrock:IngestKnowledgeBaseDocuments",
          "bedrock:DeleteKnowledgeBaseDocuments",
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs",
          "bedrock:GetKnowledgeBase",
          "bedrock:GetDataSource",
          "bedrock:GetKnowledgeBaseDocuments",
        ],
        resources: [
          "*"
        ]
      })
    );
    
    // Chat
    const chatLambda = new lambda.Function(this, "ChatLambda", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "chat.handler",
      code: lambda.Code.fromAsset("lambda"),
      environment: {
        KNOWLEDGEBASE_ID: kb.knowledgeBaseId,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });
    chatLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:Retrieve",
          "bedrock:RetrieveAndGenerate",
          "bedrock:InvokeModel",
        ],
        resources: ["*"],
      })
    );

    // Full Drive Sync
    const fullSyncLambda = new lambda.Function(
      this,
      "GoogleDriveFullSyncLambda",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "googleDriveFullSync.handler",
        code: lambda.Code.fromAsset("lambda"),

        environment: {
          KNOWLEDGEBASE_ID: kb.knowledgeBaseId,
          KNOWLEDGEBASE_SOURCE_ID: kb.dataSourceId,
        },

        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
      }
    );
    fullSyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/chatbot/drive/*`,
        ],
      })
    );
    fullSyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "UpdateBedrockDocuments",
        actions: [
          "bedrock:IngestKnowledgeBaseDocuments",
          "bedrock:DeleteKnowledgeBaseDocuments",
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs",
          "bedrock:GetKnowledgeBase",
          "bedrock:GetDataSource",
          "bedrock:GetKnowledgeBaseDocuments",
          "bedrock:ListKnowledgeBaseDocuments",
        ],
        resources: [
          "*"
        ]
      })
    );

    // == Secrets    
    const googleSecret = secretsmanager.Secret.fromSecretNameV2(this,
      'GoogleDriveSecret',
      'chatbot-drive-sync-key'
    );
    googleSecret.grantRead(syncLambda);
    googleSecret.grantRead(fullSyncLambda);

    // API Gateways
    const syncApi = new apigateway.LambdaRestApi(this, 'DriveSyncApi', {
      handler: syncLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'SyncApiUrl', { value: syncApi.url });
    
    const receiverApi = new apigateway.LambdaRestApi(this, 'GoogleDriveReceiverApi', {
      handler: receiverLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'ReceiverApiUrl', { value: receiverApi.url });

    const chatApi = new apigateway.LambdaRestApi(this, 'ChatApi', {
      handler: chatLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'ChatApiUrl', { value: chatApi.url });
    
    const fullSyncApi = new apigateway.LambdaRestApi(this, 'DriveFullSyncApi', {
      handler: fullSyncLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'FullSyncApiUrl', { value: fullSyncApi.url });

    // Watch
    const watchLambdaName = "aguaclara-drive-watch";
    const schedulerRoleName = "aguaclara-drive-watch-scheduler";

    const schedulerRole = new iam.Role(this, "DriveWatchSchedulerRole", {
      roleName: schedulerRoleName,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );

    const watchLambda = new lambda.Function(this, "DriveWatchLambda", {
      functionName: watchLambdaName,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "googleDriveWatch.handler",
      code: lambda.Code.fromAsset("lambda"),
      environment: {
        WEBHOOK_URL: receiverApi.url,
        SCHEDULER_ROLE_ARN: `arn:aws:iam::${this.account}:role/${schedulerRoleName}`,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });
    watchLambda.addEnvironment(
      "WATCH_LAMBDA_ARN", 
      `arn:aws:lambda:${this.region}:${this.account}:function:${watchLambdaName}`
    );
    googleSecret.grantRead(watchLambda);
    watchLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/chatbot/drive/*`
        ]
      })
    );
    watchLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:CreateSchedule"],
        resources: ["*"],
      })
    );
    watchLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/aguaclara-drive-watch-scheduler`
        ],
      })
    );

    const watchAPI = new apigateway.LambdaRestApi(this, 'WatchAPI', {
      handler: watchLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'WatchApiUrl', { value: watchAPI.url });

    // === Triggers
    // SQS Events
    syncLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(driveSyncQueue, {
        batchSize: 1,
        maxBatchingWindow: cdk.Duration.seconds(0)
      })
    );

  }
}
