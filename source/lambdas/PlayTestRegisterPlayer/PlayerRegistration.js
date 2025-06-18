import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

//used for creating a hash of the playtester
import crypto from 'crypto';

// Function to generate a hash
const generateHash = (stringValue, salt) => {
    const hash = crypto
        .pbkdf2Sync(stringValue, salt, 1000, 64, "sha512")
        .toString("hex");
    return hash;
};

//I need to import parameter store
const ssmClient = new SSMClient();

const dynamoDB = DynamoDBDocument.from(new DynamoDB());

export const handler = async (event) => {
    try {
        let parameterName = "playtestURL"; // Replace with your parameter name
        const withDecryption = true; // Set to true if the parameter is encrypted

        //Since Java has already turned the JSON into an object we can treat it like an object
        const body = JSON.parse(event.body);
        const playtesterId = body.playtesterId;
        const playtestsessionId = body.playtestsessionId;
        //console.log("BODY: " + body);
        //console.log("Playtester: " + playtesterId);
        //console.log("SessionID: " + playtestsessionId);

        //hash testing
        const hashedPlaytester = generateHash(playtesterId, playtestsessionId);
        console.log(`Generated Hash: ` + hashedPlaytester);

        // Create the command to fetch the parameter URL value for playtesting
        let command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });

        // Execute the command to get the URL
        let response = await ssmClient.send(command);

        // Retrieve the parameter value
        const parameterStoreURL = response.Parameter?.Value;

        //Now we get the parameter for playtester username and password
        parameterName = "playtestUsername";
        command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });
        response = await ssmClient.send(command);
        const playtesterUsername = response.Parameter?.Value;

        //Now the password
        parameterName = "playtestPassword";
        command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });
        response = await ssmClient.send(command);
        const playtesterPassword = response.Parameter?.Value;

        //console.log("Parameter Value:", parameterValue);

        if (!playtesterId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: "Missing 'playtesterId' parameter in request body." }),
            };
        }

        // Check if the playtester exists
        const getParams = {
            TableName: process.env.PLAYTESTERS_TABLE,
            Key: {
                playtesterID: hashedPlaytester,
                playtestsessionID: playtestsessionId
            },
        };

        const result = await dynamoDB.get(getParams);

        if (!result.Item) {
            // If the playtester doesn't exist, create a new record
            const putParams = {
                TableName: process.env.PLAYTESTERS_TABLE,
                Item: {
                    playtesterID: hashedPlaytester,
                    playtestsessionID: playtestsessionId,
                    playtesterName: playtesterId,
                    recordedObservations: ""
                },
            };

            await dynamoDB.put(putParams);
        }

        // Respond with a success message
        return {
            statusCode: 200,
            body: JSON.stringify({
                playtestURL: "https://" + parameterStoreURL + "/playtest?id=" + hashedPlaytester + "&sessionId=" + playtestsessionId,
                username: playtesterUsername,
                password: playtesterPassword
            }),
        };
    } catch (error) {
        console.error("Error processing request:", error);

        // Respond with an error message
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error", error: error.message }),
        };
    }
};
