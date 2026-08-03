// googleDriveReceiver.js
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const sqs = new SQSClient({});

exports.handler = async (event) => {
    console.log("Google Drive notification:");
    console.log(JSON.stringify(event, null, 2));

    // await sqs.send(new SendMessageCommand({
    //     QueueUrl: process.env.QUEUE_URL,
    //     MessageBody: JSON.stringify({
    //         timestamp: Date.now(),
    //         headers: event.headers
    //     })
    // }));

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "text/plain",
        },
        body: "OK",
    };
}