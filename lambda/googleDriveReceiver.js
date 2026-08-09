// googleDriveReceiver.js
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const sqs = new SQSClient({});

exports.handler = async (event) => {
    const headers = event.headers ?? {};
    console.log("Google Drive notification:", {
        state: headers["X-Goog-Resource-State"],
        channelId: headers["X-Goog-Channel-ID"],
        resourceId: headers["X-Goog-Resource-ID"],
        expiration: headers["X-Goog-Channel-Expiration"],
        messageNumber: headers["X-Goog-Message-Number"],
    });

    // Ignore non-change notification (i.e initialization)
    if (headers["X-Goog-Resource-State"] !== "change") {
        console.log("Ignored");
        return {
            statusCode: 200,
            body: "Ignored"
        };
    }
    console.log("Not ignored");

    await sqs.send(
        new SendMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            MessageBody: "drive-change"
        })
    );

    return {
        statusCode: 200,
        body: "Queued"
    };
}