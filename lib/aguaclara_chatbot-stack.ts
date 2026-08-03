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
    const receiverLambda = new lambda.Function(this, 'GoogleDriveReiverLambda', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'googleDriveReceiver.handler',
        code: lambda.Code.fromAsset('lambda'),
        environment: {
          QUEUE_URL: driveSyncQueue.queueUrl
        },
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
    });
    driveSyncQueue.grantSendMessages(receiverLambda);

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
    });
    syncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/chatbot/demo-drive/*`
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

    // == Secrets    
    const googleSecret = secretsmanager.Secret.fromSecretNameV2(this,
      'GoogleDriveSecret',
      'chatbot-drive-sync-key'
    );
    googleSecret.grantRead(syncLambda);

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

    // Triggers
    syncLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(driveSyncQueue, {
        batchSize: 1,
        maxBatchingWindow: cdk.Duration.seconds(0),
      })
    );

    
    const registerLambda = new lambda.Function(this, "RegisterLambda", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "register.handler",
      code: lambda.Code.fromAsset("lambda"),
      environment: {
        WEBHOOK_URL: receiverApi.url,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });
    googleSecret.grantRead(registerLambda);
    registerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/chatbot/demo-drive/*`
        ]
      })
    );

    const registerApi = new apigateway.LambdaRestApi(this, 'RegisterApi', {
      handler: registerLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'RegisterApiUrl', { value: registerApi.url });

  }
}
