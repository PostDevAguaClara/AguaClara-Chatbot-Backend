//googleDriveWatch.js
const GoogleDriveClient = require("./googleDriveClient");
const { SchedulerClient, CreateScheduleCommand } = require("@aws-sdk/client-scheduler");

const drive = new GoogleDriveClient("chatbot-drive-sync-key");
const scheduler = new SchedulerClient({});
const RENEWAL_MARGIN_MS = 1000 * 60 * 5 // 5 minutes

exports.handler = async () => {
    // Stop previous channel
    const previousChannel = await drive.loadWatchChannel();
    if (previousChannel) {
        try { 
            await drive.stopWatchChannel(previousChannel);
            console.log("Stopped previous watch: ", previousChannel.id);
        }
        catch (err) { console.warn("Failed to stop previous watch:", err); }
    }

    // Create new channel
    const channel = await drive.startWatchChannel(process.env.WEBHOOK_URL);
    console.log("Watch created:", JSON.stringify(channel, null, 2));
    await drive.saveWatchChannel(channel);

    // Shedule renewal
    const renewalDate = new Date(channel.expiration - RENEWAL_MARGIN_MS);
    await scheduler.send(
        new CreateScheduleCommand({
            Name: `drive-watch-renew-${channel.id}`,
            ScheduleExpression: `at(${renewalDate.toISOString().slice(0, 19)})`,
            FlexibleTimeWindow: { Mode: "OFF" },
            ActionAfterCompletion: "DELETE",

            Target: {
                Arn: process.env.WATCH_LAMBDA_ARN,
                RoleArn: process.env.SCHEDULER_ROLE_ARN
            }
        })
    );

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(
            {
                channelId: channel.id,
                resourceId: channel.resourceId,
                address: channel.address,
                expirationDate: new Date(channel.expiration).toISOString(),
                scheduledRenew: renewalDate.toISOString()
            },
            null, 2
        ),
    };
};