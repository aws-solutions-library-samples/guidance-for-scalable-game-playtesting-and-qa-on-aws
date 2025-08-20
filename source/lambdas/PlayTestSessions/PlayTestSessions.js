import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { GameLiftStreamsClient, CreateApplicationCommand, DeleteStreamGroupCommand } from '@aws-sdk/client-gameliftstreams';
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { v4 as uuidv4 } from 'uuid'; // Use UUID if you want to generate unique IDs

const dynamo = DynamoDBDocument.from(new DynamoDB());
const client = new GameLiftStreamsClient();
const sfnclient = new SFNClient();

/**
 * Demonstrates a simple HTTP endpoint using API Gateway. You have full
 * access to the request and response payload, including headers and
 * status code.
 *
 * To scan a DynamoDB table, make a GET request with the TableName as a
 * query string parameter. To put, update, or delete an item, make a POST,
 * PUT, or DELETE request respectively, passing in the payload to the
 * DynamoDB API as a JSON body.
 * 
 * Get Example:  https://863qw6rnfb.execute-api.us-east-2.amazonaws.com/apiprod/playtestsessions/?TableName=playtestingsessions
 * 
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
                const deletePlaytestID = event.queryStringParameters?.playtestingID;
                if (!deletePlaytestID) throw new Error("Missing playtestingID");

                await dynamo.delete({
                    TableName: process.env.PLAYTESTSESSION_TABLE,
                    Key: {
                        playtestingID: deletePlaytestID,
                    },
                });

                const input = { // DeleteStreamGroupInput
                    Identifier: deletePlaytestID.split("--")[0], // the stream group is the first part of the playtestingID
                };
                const commandDeleted = new DeleteStreamGroupCommand(input);
                await client.send(commandDeleted);

                body = { message: `Playtest session '${deletePlaytestID}' deleted successfully.` };
                break;
            case 'GET':

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

                body = await dynamo.scan(params);
                break;
            case 'POST': // Used for updates
                const requestBody = JSON.parse(event.body);
                console.log("Received request body:", requestBody);
                if (!requestBody.playtestingID) {
                    throw new Error("Missing playtestingID in the request body.");
                }

                const updateFields = { ...requestBody };
                delete updateFields.playtestingID; // don't try to update the primary key

                if (Object.keys(updateFields).length === 0) {
                    throw new Error("No fields to update.");
                }

                // Build dynamic UpdateExpression
                const expressionParts = [];
                const expressionValues = {};

                for (const key of Object.keys(updateFields)) {
                    const attributeKey = `:${key}`;
                    expressionParts.push(`${key} = ${attributeKey}`);
                    expressionValues[attributeKey] = updateFields[key];
                }

                const updateExpression = `SET ${expressionParts.join(", ")}`;

                const temp = await dynamo.update({
                    TableName: process.env.PLAYTESTSESSION_TABLE,
                    Key: {
                        playtestingID: requestBody.playtestingID,
                    },
                    UpdateExpression: `
                        SET 
                            #status = :status,
                            #name = :name,
                            enabled = :enabled,
                            endDate = :endDate,
                            startDate = :startDate,
                            startTime = :startTime,
                            studio = :studio,
                            observations = :observations
                    `,
                    ExpressionAttributeNames: {
                        "#status": "status",
                        '#name': 'name'
                    },
                    ExpressionAttributeValues: {
                        ":status": requestBody.status,
                        ":name": requestBody.name,
                        ":enabled": requestBody.enabled,
                        ":endDate": requestBody.endDate,
                        ":startDate": requestBody.startDate,
                        ":startTime": requestBody.startTime,
                        ":studio": requestBody.studio,
                        ":observations": requestBody.observations,
                    },
                    ReturnValues: "UPDATED_NEW",
                });


                console.log("Updated fields:", temp);

                body = { message: "Data updated successfully." };
                break;

            case 'PUT': // used for new
                if (!event.body) {
                    throw new Error("Missing body in the request.");
                }

                const newSession = JSON.parse(event.body);
                // Parse the JSON body
                const parsedBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

                //if (!newSession.playtestingID) {
                //    throw new Error("Missing playtestingID in the request body.");
                //}

                //needed outside if statement
                let appResponse = "";

                //If applicationSelected is not empty then we create a new applciation otherwise we use app selected
                if (newSession.applicationSelected == "") {

                    //console.log('Description:', JSON.stringify(newSession.sg_description));
                    //console.log('RunTime:', JSON.stringify(JSON.parse(newSession.runtimeEnvironment).Type));
                    //console.log('ExecutionApp:', JSON.stringify(newSession.executionS3Path));
                    //console.log('S3Path:', JSON.stringify(newSession.s3Path));

                    const input = { // CreateApplicationInput
                        Description: newSession.game, // required
                        RuntimeEnvironment: JSON.parse(newSession.runtimeEnvironment),
                        ExecutablePath: newSession.executionS3Path.replace(newSession.s3Path,''), // required
                        ApplicationSourceUri: newSession.s3Path, // required
                    };

                    //starts the create app process within GL Streams
                    const createAppCommand = new CreateApplicationCommand(input);

                    appResponse = await client.send(createAppCommand);

                    //Let's go ahead and set the applicationSelected to the newly created application
                    newSession.applicationSelected = appResponse.Id
                    parsedBody.applicationSelected = appResponse.Id;
                }
                else {
                    appResponse = { Id: newSession.applicationSelected }
                    parsedBody.applicationSelected = newSession.applicationSelected;
                }

                // Generate a unique playtestingID (or however you're generating it)
                const playtestingID = `pt-${uuidv4()}`;
                const newPlaytestingID = playtestingID + "--" + appResponse.Id;

                // Create a new object with only the fields you want to store
                const itemToStore = {
                    playtestingID: newPlaytestingID,
                    name: newSession.name,
                    game: newSession.game,
                    studio: newSession.studio,
                    startDate: newSession.startDate,
                    endDate: newSession.endDate,
                    startTime: newSession.startTime,
                    enabled: newSession.enabled,
                    observations: newSession.observations,
                    status: "Initializing" //status: Initializing, Active, Deleting
                };

                await dynamo.put({
                    TableName: process.env.PLAYTESTSESSION_TABLE,
                    Item: itemToStore,
                });

                ////
                //HERE we send to Step Function
                ////

                // Add it to the payload
                const stepFunctionPayload = {
                    ...parsedBody,
                    newPlaytestingID,
                };

                const command = new StartExecutionCommand({
                    stateMachineArn: process.env.STEP_FUNCTION_ARN,
                    input: JSON.stringify(stepFunctionPayload),
                });

                await sfnclient.send(command);

                body = { message: "Data added successfully." };
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
