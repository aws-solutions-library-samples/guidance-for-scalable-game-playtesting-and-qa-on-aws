import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocument.from(new DynamoDB());

/**
 * Demonstrates a simple HTTP endpoint using API Gateway. You have full
 * access to the request and response payload, including headers and
 * status code.
 *
 * To scan a DynamoDB table, make a GET request with the TableName as a
 * query string parameter. To put, update, or delete an item, make a POST,
 * PUT, or DELETE request respectively, passing in the payload to the
 * DynamoDB API as a JSON body.
 */
export const handler = async (event) => {
    //console.log('Received event:', JSON.stringify(event, null, 2));

    let body;
    let statusCode = '200';
    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "X-Requested-With": "*",
    };

    try {
        switch (event.httpMethod) {
            case 'DELETE':
                body = await dynamo.delete(JSON.parse(event.body));
                break;
            case 'GET':

                if (event.queryStringParameters && event.queryStringParameters.sessionId) {
                    body = await dynamo.query({
                        TableName: process.env.PLAYTESTERS_TABLE,
                        IndexName: "playtestsessionID-index", //Use the GSI you created
                        KeyConditionExpression: "playtestsessionID = :sessionId",
                        ExpressionAttributeValues: {
                            ":sessionId": event.queryStringParameters.sessionId
                        }
                    });
                } else {
                    body = await dynamo.scan({ TableName: process.env.PLAYTESTERS_TABLE });
                }

                break;
            case 'POST':
                const requestBody = JSON.parse(event.body);

                if (!requestBody.Id || !requestBody.sessionId || !requestBody.myObservations) {
                    throw new Error("Missing Id, sessionId, or myObservations in the request body.");
                }

                await dynamo.update({
                    TableName: process.env.PLAYTESTERS_TABLE,
                    Key: {
                        playtesterID: requestBody.Id, // Partition Key
                        playtestsessionID: requestBody.sessionId, // Sort Key
                    },
                    UpdateExpression: "SET recordedObservations = :recordedObservations",
                    ExpressionAttributeValues: {
                        ":recordedObservations": requestBody.myObservations,
                    },
                    ReturnValues: "UPDATED_NEW",
                });

                body = { message: "Data updated successfully." };
                break;
            case 'PUT':
                body = await dynamo.update(JSON.parse(event.body));
                break;
            default:
                throw new Error(`Unsupported method "${event.httpMethod}"`);
        }
    } catch (err) {
        statusCode = '400';
        body = err.message;
    } finally {
        body = JSON.stringify(body);
    }

    return {
        statusCode,
        body,
        headers,
    };
};
