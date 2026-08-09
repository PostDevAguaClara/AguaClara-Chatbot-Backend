// googleSync.js
const { GoogleAuth } = require("google-auth-library");
const { 
    SecretsManagerClient, 
    GetSecretValueCommand 
} = require("@aws-sdk/client-secrets-manager");
const { 
    S3Client, 
    PutObjectCommand, 
    DeleteObjectCommand, 
    HeadObjectCommand 
} = require("@aws-sdk/client-s3");
const { 
    SSMClient, 
    GetParameterCommand, 
    PutParameterCommand 
} = require("@aws-sdk/client-ssm");
const {
  BedrockAgentClient,
  IngestKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseDocumentsCommand
} = require("@aws-sdk/client-bedrock-agent");

const PARAM_NAME = "/chatbot/drive/lastSyncToken";
const BUCKET = process.env.INPUT_BUCKET;
const KB_ID = process.env.KNOWLEDGEBASE_ID;
const KB_SOURCE_ID = process.env.KNOWLEDGEBASE_SOURCE_ID;

const s3 = new S3Client({});
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const kbClient = new BedrockAgentClient({});

const DOWNLOADABLE_MIME_TYPES = new Set([
    "text/plain",       // txt
    "text/markdown",    // md
    "text/csv",         // csv
    "text/html",        // html
    "application/pdf",  // pdf
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // excel (.xlxs)
    "application/vnd.google-apps.document",     // Google Docs
    "application/vnd.google-apps.presentation", // Google Slides
    "application/vnd.google-apps.spreadsheet"   // Google Sheets
]);

const GoogleDriveClient = require("./googleDriveClient");
const drive = new GoogleDriveClient("chatbot-drive-sync-key");

exports.handler = async () => {
    console.log("GOOGLE SYNC STARTED");

    // Load/init sync page token
    let pageToken = await drive.loadPageToken();
    if (!pageToken) { pageToken = await drive.createPageToken(); }

    // Process changes
    let newStartToken = pageToken;
    while (pageToken) {
        const result = await drive.getChanges(pageToken);

        // Iteratively sync changes
        for (const change of result.changes) {
            console.log("CHANGE:", JSON.stringify(change, null, 2));
            try {
                await syncChange(change);
            } catch (err) {
                console.error(
                    "Failed to sync file:", change.fileId,
                    err
                );
                throw err;
            }
        }

        pageToken = result.nextPageToken;
        newStartToken = result.newStartPageToken;
    }

    // Update persistant sync token
    await drive.savePageToken(newStartToken);
    
    console.log("SYNC COMPLETE");
    return {
        statusCode: 200,
        body: "Sync complete"
    };
};

/**
 * Synchronizes a change in the Google Drive to the S3 bucket
 * 
 * @param change A token for a change in the Google Drive
 */
async function syncChange(change) {
    const fileId = change.fileId;

    // File deletion
    if (change.removed || change.file.trashed) {
        console.log("Deleting document...");
        // Delete from S3
        // await s3.send(
        //     new DeleteObjectCommand({
        //         Bucket: BUCKET,
        //         Key: fileId,
        //     })
        // );

        // Delete from knowledgebase
        await kbClient.send(
            new DeleteKnowledgeBaseDocumentsCommand({
                knowledgeBaseId: KB_ID,
                dataSourceId: KB_SOURCE_ID,
                documentIdentifiers: [
                    {
                        dataSourceType: "CUSTOM",
                        custom: { id: fileId }
                    }
                ]
            })
        );
        return;
    }

    const metaData = await drive.getMetaData(fileId);
    const fileName = metaData.name;
    console.log("Syncing file:", fileName, `\t Type: ${metaData.mimeType}`);

    if (!DOWNLOADABLE_MIME_TYPES.has(metaData.mimeType)) {
        console.log(
            `Skipping document ${fileName}\n
                Reason: Unsupported type ${JSON.stringify(metaData.mimeType, null, 2)}`
        );
        return;
    }

    // Download file from Drive
    console.log("Importing from Drive:", fileName);
    const { body, contentType } = await drive.getContent(fileId, metaData.mimeType);
    const path = await drive.getFilePath(metaData.name, metaData.parents);
    
    // Upload to S3
    // console.log("Uploading document to S3:", fileId);
    // await s3.send(
    //     new PutObjectCommand({
    //         Bucket: BUCKET,
    //         Key: fileId,
    //         Body: body,
    //         ContentType: contentType,
    //         Metadata: {
    //             "file-id": fileId,
    //             "file-name": fileName,
    //             "modified-time": metaData.modifiedTime,
    //             "web-view-link": metaData.webViewLink,
    //             "path": path,
    //         }
    //     })
    // );

    // Ingest document into knowledgebase
    console.log("Ingesting document:", fileId);
    const document = {
        content: {
            dataSourceType: "CUSTOM",
            custom: {
                customDocumentIdentifier: {
                    id: fileId
                },
                sourceType: "IN_LINE",
                inlineContent: {
                    type: "BYTE",
                    byteContent: {
                        data: body,
                        mimeType: contentType
                    }
                }
            }
        },
        metadata: {
            "type": "IN_LINE_ATTRIBUTE",
            "inlineAttributes": [
                { 
                    "key": "file-name",
                    "value": { type: "STRING", "stringValue": fileName }
                },
                { 
                    "key": "web-view-link",
                    "value": { type: "STRING", "stringValue": metaData.webViewLink }
                },
                { 
                    "key": "path",
                    "value": { type: "STRING", "stringValue": path }
                }
            ]
        }
    };

    console.log("Ingestion:", {
        knowledgeBaseId: KB_ID,
        dataSourceId: KB_SOURCE_ID,
        KBytes: body.length / 1024,
        type: contentType,
        isBuffer: Buffer.isBuffer(body),
        firstBytes: body.slice(0, 4).toString("hex")
    });
    const result = await kbClient.send(
        new IngestKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: KB_SOURCE_ID,
            documents: [ document ]
        })
    );
    console.log("Ingestion result:", JSON.stringify(result, null, 2));
}

