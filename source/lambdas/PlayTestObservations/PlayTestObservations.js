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
                const playtestSessionId = event.queryStringParameters.sessionId;
                const playerId = event.queryStringParameters.id;

                // 1. Get observations from playtestsession_table
                const sessionParams = {
                    TableName: process.env.PLAYTESTSESSION_TABLE,
                    Key: {
                        playtestingID: playtestSessionId
                    },
                };

                const sessionResponse = await dynamo.get(sessionParams);
                
                if (!sessionResponse.Item) {
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ Error: "Missing Record" }),
                    };
                }

                // Get base observations
                const baseObservations = sessionResponse.Item.observations || [];

                if (!Array.isArray(baseObservations) || baseObservations.length === 0) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ Observations: [] }),
                    };
                }

                // 2. Check for existing responses in PLAYTESTERS_TABLE
                if (playerId) {
                    const playtesterParams = {
                        TableName: process.env.PLAYTESTERS_TABLE,
                        Key: {
                            playtesterID: playerId,
                            playtestsessionID: playtestSessionId
                        }
                    };

                    try {
                        const playtesterResponse = await dynamo.get(playtesterParams);

                        if (playtesterResponse.Item?.recordedObservations?.observations) {
                            // Extract recorded observations - note the change in structure here
                            const recordedObservations = playtesterResponse.Item.recordedObservations.observations;

                            // Merge base observations with recorded responses
                            const mergedObservations = baseObservations.map(baseObs => {
                                // Find matching recorded observation
                                const recordedObs = recordedObservations.find(
                                    rec => rec.id === baseObs.id &&
                                          rec.observation === baseObs.observation
                                );

                                return {
                                    id: baseObs.id,
                                    observation: baseObs.observation,
                                    response: recordedObs ? recordedObs.response : ""
                                };
                            });

                            return {
                                statusCode: 200,
                                headers,
                                body: JSON.stringify({ Observations: mergedObservations }),
                            };
                        }
                    } catch (error) {
                        console.error('Error fetching playtester responses:', error);
                    }
                }

                // If no recorded observations found, return base observations
                const plainBaseObservations = baseObservations.map(obs => ({
                    id: obs.id,
                    observation: obs.observation,
                    response: obs.response || ""
                }));

                console.log("PLAINBASE_OBS: " + JSON.stringify(plainBaseObservations));
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ Observations: plainBaseObservations }),
                };

            // ... rest of your switch cases remain the same ...
            case 'DELETE':
                body = await dynamo.delete(JSON.parse(event.body));
                break;
            case 'POST':
                body = await dynamo.put(JSON.parse(event.body));
                break;
            case 'PUT':
                body = await dynamo.update(JSON.parse(event.body));
                break;
            default:
                throw new Error(`Unsupported method "${event.httpMethod}"`);
        }
    } catch (err) {
        console.error('Error:', err);
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ 
                error: err.message,
                details: 'Error processing request'
            })
        };
    }
};
