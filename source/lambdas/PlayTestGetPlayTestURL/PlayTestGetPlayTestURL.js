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

export const handler = async (event) => {
    try {

        let parameterName = "playtestURL"; // Replace with your parameter name
        const withDecryption = true; // Set to true if the parameter is encrypted

        //I need to get playtestSessionID from the POST event body along with the discordHandleName
        //Since Java has already turned the JSON into an object we can treat it like an object
        let body = JSON.parse(event.body);
        const playtesterId = body.playtesterId;
        const playtestsessionId = body.playtestsessionId;

        //hash testing
        const hashedPlaytester = generateHash(playtesterId, playtestsessionId);
        //console.log(`Generated Hash: ` + hashedPlaytester);
        

         // Create the command to fetch the parameter URL value for playtesting
         let command = new GetParameterCommand({
             Name: parameterName,
             WithDecryption: withDecryption,
         });
 
         // Execute the command to get the URL
         let response = await ssmClient.send(command);
 
         // Retrieve the parameter value
         const parameterStoreURL = response.Parameter?.Value;

        return {
            statusCode: 200,
            body: JSON.stringify({
                playtestURL: "https://" + parameterStoreURL + "/playtest?id=" + hashedPlaytester + "&sessionId=" + playtestsessionId
            }),
        
        };

    }catch (error) {
        console.error("Error processing request:", error);

        // Respond with an error message
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error", error: error.message }),
        };
    }
};