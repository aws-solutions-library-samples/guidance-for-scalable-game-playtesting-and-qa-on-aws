import { S3, ListBucketsCommand } from '@aws-sdk/client-s3';

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
        const data = await s3.send(new ListBucketsCommand({}));
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify(data.Buckets),
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ message: error.message }),
            headers: headers
        };
    }
};
