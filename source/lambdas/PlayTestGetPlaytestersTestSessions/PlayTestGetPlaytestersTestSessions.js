import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const dynamoDB = DynamoDBDocument.from(new DynamoDB());

export const handler = async (event) => {
    try {
        // Parse the request body to get playtesterId
        const body = JSON.parse(event.body);
        const playtesterId = body.playtesterId;

        if (!playtesterId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: "Missing 'playtesterId' parameter in request body." })
            };
        }

        // First query: Get all playtestsessionIds for this playtester
        const playtesterParams = {
            TableName: process.env.PLAYTESTERS_TABLE,
            FilterExpression: "playtesterName = :playerId",
            ExpressionAttributeValues: {
                ":playerId": playtesterId
            }
        };

        const playtesterResults = await dynamoDB.scan(playtesterParams);
        
        // If no sessions found for this playtester
        if (!playtesterResults.Items || playtesterResults.Items.length === 0) {
            return {
                statusCode: 200,
                body: JSON.stringify([]) // Return empty array if no sessions found
            };
        }

        // Extract unique playtestsessionIds
        const sessionIds = [...new Set(playtesterResults.Items.map(item => item.playtestsessionID))];

        // Get today's date in ISO format
        const today = new Date().toISOString().split("T")[0];

        // Since we can't use IN operator, we'll need to query for each sessionId
        const sessionPromises = sessionIds.map(sessionId => {
            return dynamoDB.scan({
                TableName: process.env.PLAYTESTSESSION_TABLE,
                FilterExpression: "playtestingID = :sessionId AND #endDate >= :today AND #enabled = :enabled",
                ExpressionAttributeNames: {
                    "#endDate": "endDate",
                    "#enabled": "enabled"
                },
                ExpressionAttributeValues: {
                    ":sessionId": sessionId,
                    ":today": today,
                    ":enabled": true
                }
            });
        });

        // Wait for all queries to complete
        const sessionResults = await Promise.all(sessionPromises);

        // Combine and format results
        const filteredSessions = sessionResults
            .flatMap(result => result.Items)
            .map(session => ({
                name: session.name,
                playtestingID: session.playtestingID,
                startTime: session.startTime,
                startDate: session.startDate,
                endDate: session.endDate
            }));

        return {
            statusCode: 200,
            body: JSON.stringify(filteredSessions)
        };

    } catch (error) {
        console.error("Error processing request:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                message: "Internal Server Error", 
                error: error.message 
            })
        };
    }
};
