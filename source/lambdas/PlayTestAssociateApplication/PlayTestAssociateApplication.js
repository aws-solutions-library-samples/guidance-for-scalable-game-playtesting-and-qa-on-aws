import { GameLiftStreamsClient, AssociateApplicationsCommand } from '@aws-sdk/client-gameliftstreams';

const client = new GameLiftStreamsClient();

export const handler = async (event) => {
    const applicationId = event.applicationSelected;
    const streamGroupId = event.streamGroup?.Id;

    if (!applicationId || !streamGroupId) {
        throw new Error("Missing applicationSelected or streamGroup.Id");
    }

    const input = { // AssociateApplicationsInput
        Identifier: streamGroupId, // required
        ApplicationIdentifiers: [ // Identifiers // required
            applicationId,
        ],
    };

    const command = new AssociateApplicationsCommand(input);

    await client.send(command);

    // Continue passing down full state
    return event;
};
