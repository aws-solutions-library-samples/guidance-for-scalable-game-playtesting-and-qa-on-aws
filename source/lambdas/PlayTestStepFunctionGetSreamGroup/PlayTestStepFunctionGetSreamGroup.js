import { GameLiftStreamsClient, GetStreamGroupCommand } from "@aws-sdk/client-gameliftstreams";

const client = new GameLiftStreamsClient();

export const handler = async (event) => {
    try {
        console.log("event: " + JSON.stringify(event));

        const input = { // GetStreamGroupInput
            Identifier: event.streamGroup.Id, // required
        };
        const command = new GetStreamGroupCommand(input);
        const data = await client.send(command);

        return {
            Id: data.Id,
            status: data.Status
        };
    } catch (error) {
        console.log("ERROR: " + error);
        return {
            status: 'ERROR'
        };
    }
};
