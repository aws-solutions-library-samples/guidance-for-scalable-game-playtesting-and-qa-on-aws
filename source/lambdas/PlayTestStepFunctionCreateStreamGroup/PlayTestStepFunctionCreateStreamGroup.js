import { GameLiftStreamsClient, CreateStreamGroupCommand } from "@aws-sdk/client-gameliftstreams";

const client = new GameLiftStreamsClient();

export const handler = async (event) => {
    try {
        console.log("event: " + JSON.stringify(event));

        // Filter capacityConfig to only include selected locations
        const selectedSet = new Set(event.selectedLocations);
        const locationConfigurations = event.capacityConfig
            .filter(cfg => selectedSet.has(cfg.location))
            .map(cfg => ({
                LocationName: cfg.location,
                AlwaysOnCapacity: Number(cfg.alwaysOn),
                OnDemandCapacity: Number(cfg.onDemand)
            }));

        const input = {
            Description: event.sg_description,
            StreamClass: event.sg_class.value,
            LocationConfigurations: locationConfigurations
        };

        const command = new CreateStreamGroupCommand(input);
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
