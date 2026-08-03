//knowledge-base.ts
import * as cdk from 'aws-cdk-lib';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

import { Construct } from 'constructs';

const TITAN_EMBEDDING_DIMENSION = 1024;

export class KnowledgeBase extends Construct {
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const region = cdk.Stack.of(this).region;
    const embeddingModelArn = 
        `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`;

    // S3 Vector
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {})
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
        vectorBucketArn: vectorBucket.attrVectorBucketArn,
        dataType: 'float32',
        dimension: TITAN_EMBEDDING_DIMENSION,
        distanceMetric: 'cosine',
        metadataConfiguration: {
            'nonFilterableMetadataKeys': [
                'AMAZON_BEDROCK_TEXT',
                'AMAZON_BEDROCK_METADATA'
            ]
        }
    });
    vectorIndex.addDependency(vectorBucket);
    
    // IAM role
    const kbRole = new iam.Role(this, 'kbRole', {
        assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com")
    });
    kbRole.addToPolicy(
        new iam.PolicyStatement({
            actions: ["bedrock:InvokeModel"],
            resources: [embeddingModelArn]
        })
    );
    kbRole.addToPolicy(
        new iam.PolicyStatement({
            actions: [
                "s3vectors:GetVectors",
                "s3vectors:QueryVectors",
                "s3vectors:PutVectors",
                "s3vectors:DeleteVectors",
                "s3vectors:GetIndex",
            ],
            resources: [vectorIndex.attrIndexArn]
        })
    );

    // Knowledgebase
    const kb = new bedrock.CfnKnowledgeBase(this, 'ChatbotKB', {
        name: 'chatbot-knowledge-base',
        roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
            type: 'VECTOR',
            vectorKnowledgeBaseConfiguration: {
                embeddingModelArn: embeddingModelArn
            }
        },
        storageConfiguration: {
            type: 'S3_VECTORS',
            s3VectorsConfiguration: {
                vectorBucketArn: vectorBucket.attrVectorBucketArn,
                indexArn: vectorIndex.attrIndexArn,
            }
        }
    });
    kb.node.addDependency(vectorIndex);
    kb.node.addDependency(kbRole);

    // Data Source
    const dataSource = new bedrock.CfnDataSource(this, 'ChatbotDataSource', {
        name: 'chatbot-data-source',
        description: 'The custome data source for the AguaClara chatbot KB',    // TODO: Typo
        knowledgeBaseId: kb.attrKnowledgeBaseId,
        dataSourceConfiguration: { type: 'CUSTOM' }
    })

    // Exposed values
    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;
    this.dataSourceId = dataSource.attrDataSourceId;
  }
}