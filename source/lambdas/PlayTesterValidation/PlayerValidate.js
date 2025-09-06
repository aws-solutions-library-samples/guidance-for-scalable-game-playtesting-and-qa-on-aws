import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocument.from(new DynamoDB());

export const handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "X-Requested-With": "*",
    };

    try {
        switch (event.httpMethod) {
            case 'GET':
                const id = event.queryStringParameters.id;
                const sessionId = event.queryStringParameters.sessionId;

                // First, check if the playtest session is valid
                const sessionParams = {
                    TableName: process.env.PLAYTESTSESSION_TABLE,
                    Key: {
                        playtestingID: sessionId
                    }
                };

                const sessionResponse = await dynamo.get(sessionParams);
                
                // If session doesn't exist, return false
                if (!sessionResponse.Item) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            IsValid: "false",
                            reason: "Session not found"
                        })
                    };
                }

                const session = sessionResponse.Item;
                const currentDate = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format

                // Check if session is enabled and within date range
                if (!session.enabled) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            IsValid: "false",
                            reason: "Session is disabled"
                        })
                    };
                }

                if (currentDate < session.startDate) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            IsValid: "false",
                            reason: "Session has not started yet"
                        })
                    };
                }

                if (currentDate > session.endDate) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            IsValid: "false",
                            reason: "Session has ended"
                        })
                    };
                }

                // If session is valid, check if playtester exists
                const playtesterParams = {
                    TableName: process.env.PLAYTESTERS_TABLE,
                    Key: {
                        playtesterID: id,
                        playtestsessionID: sessionId
                    },
                };

                const playtesterResponse = await dynamo.get(playtesterParams);

                // Return appropriate response based on whether playtester exists
                if (!playtesterResponse.Item) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            IsValid: "false",
                            reason: "Playtester not found"
                        }),
                    };
                }

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ 
                        IsValid: "true",
                        reason: "All validations passed"
                    }),
                };

            default:
                throw new Error(`Unsupported method "${event.httpMethod}"`);
        }
    } catch (err) {
        console.error('Error:', err);
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ 
                IsValid: "false",
                reason: "Error processing request",
                error: err.message 
            })
        };
    }
};
