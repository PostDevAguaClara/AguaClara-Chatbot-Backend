/**
 * googleDriveSync.js
 * 
 * 
 * 
 */ 
const { GoogleAuth } = require("google-auth-library");
const { 
    SecretsManagerClient, 
    GetSecretValueCommand 
} = require("@aws-sdk/client-secrets-manager");
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


exports.handler = async (event) => {
    console.log("GOOGLE SYNC STARTED");

    // Load/init sync page token
    let pageToken = await drive.loadPageToken();
    if (!pageToken) {
        throw new Error(
            "Drive sync has not been initialized. " +
            "Run the full synchronization Lambda first."
        );
    }

    // Process changes
    let changeTally = { changes: 0, ingested: 0, deleted: 0 }
    let newStartToken = pageToken;
    while (pageToken) {
        const result = await drive.getChanges(pageToken);
        changeTally.changes = result.changes?.length;
        
        // Iteratively sync changes
        for (const change of result.changes) {
            console.log("CHANGE:", JSON.stringify(change, null, 2));
            try {
                const sync = await syncChange(change);
                if (sync == "ingested")     { changeTally.ingested +=1; }
                else if (sync == "deleted") { changeTally.deleted += 1; }
            } catch (err) {
                console.error("Failed to sync file:", change.fileId, err);
                throw err;
            }
        }

        pageToken = result.nextPageToken;
        newStartToken = result.newStartPageToken;
    }

    // Update saved sync token
    await drive.savePageToken(newStartToken);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            changes: changeTally.changes,
            ingested: changeTally.ingested,
            deleted: changeTally.deleted,
            newStartToken: newStartToken,
        }),
    };
};

/**
 * Synchronizes a change in the Google Drive to the Knowledge Base
 * 
 * @param change A token for a change in the Google Drive
 */
async function syncChange(change) {
    const fileId = change.fileId;

    // File deletion
    if (change.removed || change.file.trashed) {
        console.log(`Deleting KB document ${fileId}`);
        await deleteFile(fileId);
        return "deleted";
    }

    const metaData = await drive.getMetaData(fileId);
    const fileName = metaData.name;

    if (!DOWNLOADABLE_MIME_TYPES.has(metaData.mimeType)) {
        console.log(`Skipping document ${fileName}\n` +
                    `Reason: Unsupported type ${JSON.stringify(metaData.mimeType, null, 2)}`
        );
        return "skipped";
    }
    
    // Download from Drive and ingest to KB
    console.log(`Ingesting document ${fileId} (${fileName})`);
    await ingestFile(fileId, metaData);
    return "ingested";
}

/**
 * Delete one document from the Bedrock custom data source.
 * 
 * @param fileId The Drive file id of the file
 */
async function deleteFile(fileId) {
    await kbClient.send(
        new DeleteKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: KB_SOURCE_ID,
            documentIdentifiers: [
                {
                    dataSourceType: "CUSTOM",
                    custom: { id: fileId },
                },
            ],
        })
    );
}

/**
 * Ingest one Drive file into the Bedrock custom data source.
 * 
 * @param fileId The Drive file id of the file
 * @param metaData The Drive metadata the file
 */
async function ingestFile(fileId, metaData) {
    const fileName = metaData.name;
    const { body, contentType } = await drive.getContent(fileId, metaData.mimeType);
    const path = await drive.getFilePath(metaData.name, metaData.parents);

    const document = {
        content: {
            dataSourceType: "CUSTOM",
            custom: {
                customDocumentIdentifier: { id: fileId },
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

    await kbClient.send(
        new IngestKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: KB_SOURCE_ID,
            documents: [document],
        })
    );
}
