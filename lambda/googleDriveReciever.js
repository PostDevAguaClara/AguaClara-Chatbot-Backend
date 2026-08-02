// googleDriveReciever.js
exports.handler = async () => {
    console.log("GOOGLE DRIVE CHANGE RECIEVED");

    return {
        statusCode: 200,
        body: "Changes queued"
    };
}