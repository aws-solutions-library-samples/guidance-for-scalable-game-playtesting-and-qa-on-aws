import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const dynamoDB = DynamoDBDocument.from(new DynamoDB());

export const handler = async (event) => {
    try {

        // Get today's date in ISO format (adjust format as per your data)
        const today = new Date().toISOString().split("T")[0]; // 'YYYY-MM-DD'

        // Define the scan parameters
        const params = {
            TableName: process.env.PLAYTESTSESSION_TABLE,
            FilterExpression: "#endDate >= :today AND #enabled = :enabled",
            ExpressionAttributeNames: {
                "#endDate": "endDate",     // Name of the endDate attribute
                "#enabled": "enabled",     // Name of the enabled flag
            },
            ExpressionAttributeValues: {
                ":today": today,        // Today's date for comparison
                ":enabled": true,       // Only fetch items where enabled is true
            },
        };

        let body = await dynamoDB.scan(params);
        const filteredItems = body.Items.map(item => ({
            name: item.name,
            playtestingID: item.playtestingID,
            startTime: item.startTime,
            startDate: item.startDate,
            endDate: item.endDate
        }));

        return {
            statusCode: 200,
            body:JSON.stringify(filteredItems)};

    }catch (error) {
        console.error("Error processing request:", error);

        // Respond with an error message
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error", error: error.message }),
        };
    }
};