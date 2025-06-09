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
                //body = await dynamo.scan({ TableName: event.queryStringParameters.TableName });

                // Get the TableName and primary key (id) from the query string parameters
                const tableName = process.env.PLAYTESTSESSION_TABLE;
                const id = event.queryStringParameters.id;  // Assuming the 'id' is passed as a query parameter
                //const sessionId = event.queryStringParameters.sessionId;  // Assuming the 'sessionId' is passed as a query parameter

                const params = {
                    TableName: tableName,
                    Key: {
                        playtestingID: id
                    },
                };

                body = await dynamo.get(params);

                // If the item is not found
                if (!body.Item) {
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ Error: "Missing Record" }),
                    };
                }

                //we have items then just return true
                if (body.Item.observations) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ Observations: body.Item.observations }),
                    };
                }

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
