import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { Construct } from 'constructs';
import { KnowledgeBase } from '../constructs/knowledge-base';

export class AguaclaraChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Document Knowledgebase
    const kb = new KnowledgeBase(this, 'Knowledgebase');
    const documentsBucket = kb.documentsBucket;
    
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
    const googleSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleDriveSecret',
      'demo-google-service-account'
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
