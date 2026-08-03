const GoogleDriveClient = require("./googleDriveClient");

const drive = new GoogleDriveClient("chatbot-drive-sync-key");

exports.handler = async () => {
    let pageToken = await drive.loadPageToken();
    if (!pageToken) {
        pageToken = await drive.createPageToken();
    }

    const result = await drive.watchChanges(
        pageToken,
        process.env.WEBHOOK_URL
    );

    console.log("Watch created:", JSON.stringify(result, null, 2));
    
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(result, null, 2),
    };
};