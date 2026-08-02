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

    // Document Knowledgebase
    const kb = new KnowledgeBase(this, 'Knowledgebase');
    const documentsBucket = kb.documentsBucket;
    
    // SQS Queues
    const driveSyncQueue = new sqs.Queue(this, "DriveSyncQueue", {
      visibilityTimeout: cdk.Duration.minutes(15),
    });

    // Lambdas
    const syncLambda = new lambda.Function(this, 'GoogleDriveSyncLambda', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'googleSync.handler',
        code: lambda.Code.fromAsset('lambda'),
        environment: {
          INPUT_BUCKET: documentsBucket.bucketName,
          KNOWLEDGEBASE_ID: kb.knowledgeBaseId,
          KNOWLEDGEBASE_SOURCE_ID: kb.dataSourceId,
        },
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
    });
    documentsBucket.grantRead(syncLambda);
    documentsBucket.grantWrite(syncLambda);

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

    // Secrets
    const googleSecretDemo = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleDriveSecretDemo',
      'demo-google-service-account'
    );
    googleSecretDemo.grantRead(syncLambda);
    
    const googleSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleDriveSecret',
      'chatbot-drive-sync-key'
    );
    googleSecret.grantRead(syncLambda);

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
        
    // API Gateways
    const syncApi = new apigateway.LambdaRestApi(this, 'DriveSyncApi', {
      handler: syncLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'SyncApiUrl', {
      value: syncApi.url,
    });

    const chatApi = new apigateway.LambdaRestApi(this, 'ChatApi', {
      handler: chatLambda,
      proxy: true,
    });
    new cdk.CfnOutput(this, 'ChatApiUrl', {
      value: chatApi.url,
    });

  }
}
