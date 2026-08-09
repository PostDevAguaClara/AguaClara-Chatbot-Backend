/**
 * googleDriveFullSync.js
 * 
 * Compares the contents of the KB and Drive directly, then ingests and
 * deletes KB documents as needed to ensure consistancy.
 * 
 * This updates the sync token cursor, establishing a boundary in which
 * everything prior is synced, and changes after can be handled incrementally.
 * 
 * This must be called once initally, then at any time in the case incremental
 * syncing missed changes to correct it.
 */
const {
    BedrockAgentClient,
    IngestKnowledgeBaseDocumentsCommand,
    DeleteKnowledgeBaseDocumentsCommand,
    ListKnowledgeBaseDocumentsCommand,
} = require("@aws-sdk/client-bedrock-agent");

const GoogleDriveClient = require("./googleDriveClient");

const drive = new GoogleDriveClient("chatbot-drive-sync-key");
const kbClient = new BedrockAgentClient({});

const KB_ID = process.env.KNOWLEDGEBASE_ID;
const KB_SOURCE_ID = process.env.KNOWLEDGEBASE_SOURCE_ID;

const DOWNLOADABLE_MIME_TYPES = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.spreadsheet",
]);

exports.handler = async () => {
    console.log("=== FULL DRIVE SYNC STARTED ===");

    const syncToken = await drive.createPageToken();
    const driveFiles = await getAllDriveFiles();
    const kbDocuments = await getAllKBDocuments();

    console.log(`Found ${driveFiles.size} supported files in Drive.`);
    console.log(`Found ${kbDocuments.size} documents in Knowledge Base.`);

    // Compile changes
    const toIngest = [];
    const toDelete = [];
    for (const [fileId, file] of driveFiles) {
        if (!kbDocuments.has(fileId)) { toIngest.push(file); }
    }
    for (const fileId of kbDocuments.keys()) {
        if (!driveFiles.has(fileId)) { toDelete.push(fileId); }
    }
    console.log(`Documents to ingest: ${toIngest.length}`);
    console.log(`Documents to delete: ${toDelete.length}`);

    // Ingest
    for (const file of toIngest) {
        try { await ingestFile(file); } 
        catch (err) {
            console.error( `Failed to ingest ${file.id} (${file.name})`, err);
            throw err;
        }
    }

    /*
     * Delete documents that exist in the KB but no longer exist in Drive.
     */
    for (const fileId of toDelete) {
        try { await deleteDocument(fileId); } 
        catch (err) {
            console.error(`Failed to delete KB document ${fileId}`, err);
            throw err;
        }
    }

    await drive.savePageToken(syncToken);

    console.log("Incremental sync token updated.");

    console.log("=== FULL DRIVE SYNC COMPLETE ===");

    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            driveDocuments: driveFiles.size,
            kbDocuments: kbDocuments.size,
            ingested: toIngest.length,
            deleted: toDelete.length,
        }),
    };
};


/**
 * Retrieve every supported, non-trashed file from Google Drive.
 */
async function getAllDriveFiles() {
    const files = new Map();

    let pageToken;

    /*
    while (pageToken) {
    }
    */
    do {
        const params = {
            pageSize: 1000,
            fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink,parents,trashed)",
            q: "trashed = false",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        };

        if (pageToken) {
            params.pageToken = pageToken;
        }

        const result = await drive.request("/drive/v3/files",
            { params }
        );

        if (result.incompleteSearch) {
            throw new Error(
                "Google Drive returned incompleteSearch=true. " +
                "Full synchronization cannot safely continue."
            );
        }

        for (const file of result.files ?? []) {
            if (!DOWNLOADABLE_MIME_TYPES.has(file.mimeType)) {
                continue;
            }

            files.set(file.id, file);
        }

        pageToken = result.nextPageToken;
    } while (pageToken);

    return files;
}


/**
 * Retrieve every document currently in the Bedrock custom data source.
 */
async function getAllKBDocuments() {
    const documents = new Map();

    let nextToken;

    do {
        const result = await kbClient.send(
            new ListKnowledgeBaseDocumentsCommand({
                knowledgeBaseId: KB_ID,
                dataSourceId: KB_SOURCE_ID,
                maxResults: 1000,
                nextToken,
            })
        );

        for (const document of result.documentDetails ?? []) {
            if (
                document.identifier?.dataSourceType !== "CUSTOM" ||
                !document.identifier?.custom?.id
            ) {
                continue;
            }

            const id = document.identifier.custom.id;

            documents.set(id, document);
        }

        nextToken = result.nextToken;
    } while (nextToken);

    return documents;
}


/**
 * Ingest one Drive file into the Bedrock custom data source.
 */
async function ingestFile(metaData) {
    const fileId = metaData.id;

    console.log(
        `Ingesting "${metaData.name}" (${fileId})`
    );

    console.log("Importing from Drive...");

    const {
        body,
        contentType,
    } = await drive.getContent(
        fileId,
        metaData.mimeType
    );

    const path = await drive.getFilePath(
        metaData.name,
        metaData.parents
    );

    const document = {
        content: {
            dataSourceType: "CUSTOM",
            custom: {
                customDocumentIdentifier: {
                    id: fileId,
                },
                sourceType: "IN_LINE",
                inlineContent: {
                    type: "BYTE",
                    byteContent: {
                        data: body,
                        mimeType: contentType,
                    },
                },
            },
        },

        metadata: {
            type: "IN_LINE_ATTRIBUTE",
            inlineAttributes: [
                {
                    key: "file-name",
                    value: {
                        type: "STRING",
                        stringValue: metaData.name,
                    },
                },
                {
                    key: "web-view-link",
                    value: {
                        type: "STRING",
                        stringValue: metaData.webViewLink ?? "",
                    },
                },
                {
                    key: "path",
                    value: {
                        type: "STRING",
                        stringValue: path,
                    },
                },
            ],
        },
    };

    await kbClient.send(
        new IngestKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: KB_SOURCE_ID,
            documents: [document],
        })
    );

    console.log(
        `Successfully submitted "${metaData.name}" for ingestion.`
    );
}


/**
 * Delete one document from the Bedrock custom data source.
 */
async function deleteDocument(fileId) {
    console.log(`Deleting KB document ${fileId}`);

    await kbClient.send(
        new DeleteKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: KB_SOURCE_ID,

            documentIdentifiers: [
                {
                    dataSourceType: "CUSTOM",
                    custom: {
                        id: fileId,
                    },
                },
            ],
        })
    );

    console.log(`Successfully submitted deletion for ${fileId}.`);
}