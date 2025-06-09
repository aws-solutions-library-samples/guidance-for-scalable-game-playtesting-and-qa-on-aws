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
            case 'GET':

                // Get the primary key (id) from the query string parameters
                const id = event.queryStringParameters.id;  // Assuming the 'id' is passed as a query parameter
                const sessionId = event.queryStringParameters.sessionId;  // Assuming the 'sessionId' is passed as a query parameter

                const params = {
                    TableName: process.env.PLAYTESTERS_TABLE,
                    Key: {
                        playtesterID: id,           // Partition key
                        playtestsessionID: sessionId // Sort key (if required)
                    },
                };

                body = await dynamo.get(params);

                // If the item is not found
                if (!body.Item) {
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ IsValid: "false" }),
                    };
                }

                //we have items then just return true
                if (body.Item) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ IsValid: "true" }),
                    };
                }

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
