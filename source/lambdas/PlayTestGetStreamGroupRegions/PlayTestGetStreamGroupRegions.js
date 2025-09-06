import { GameLiftStreamsClient, GetStreamGroupCommand } from "@aws-sdk/client-gameliftstreams";

const client = new GameLiftStreamsClient();

export const handler = async (event) => {
    try {
        // Parse the POST body
        const body = JSON.parse(event.body);
        
        const input = { // GetStreamGroupInput
            Identifier: body.playtestsessionId.split('--')[0], // required
        };
        
        const command = new GetStreamGroupCommand(input);
        const data = await client.send(command);
        
        // Map over LocationStates to extract just the LocationName
        const locations = data.LocationStates.map(location => location.LocationName);
        
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*", // For CORS, adjust as needed
            },
            body: JSON.stringify({
                Locations: locations
            })
        };
    } catch (error) {
        console.error("ERROR:", error);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*", // For CORS, adjust as needed
            },
            body: JSON.stringify({
                status: 'ERROR',
                message: error.message
            })
        };
    }
};
