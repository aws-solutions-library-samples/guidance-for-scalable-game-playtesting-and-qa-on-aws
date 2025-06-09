import { S3, ListObjectsV2Command } from '@aws-sdk/client-s3';

//console.log('Loading function');
const s3 = new S3();


export const handler = async (event) => {
    //console.log('Received event:', JSON.stringify(event, null, 2));

    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "X-Requested-With": "*",
    };

    try {
        const bucketName = JSON.parse(event.body).bucketName;

        if (!bucketName) {
            return { statusCode: 400, body: JSON.stringify({ error: "Bucket name is required" }), headers: headers };
        }

        const command = new ListObjectsV2Command({ Bucket: bucketName });
        const response = await s3.send(command); //Correct usage in SDK v3

        const objects = response.Contents?.map(obj => ({
            Key: obj.Key,
            IsFolder: obj.Key.endsWith("/")
        })) || [];
        console.log("Objects:", objects);
        return {
            statusCode: 200,
            body: JSON.stringify(objects),
            headers: headers
        };
    } catch (error) {
        console.error("Error listing objects:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to fetch objects" }),
            headers: headers
        };
    }
};
