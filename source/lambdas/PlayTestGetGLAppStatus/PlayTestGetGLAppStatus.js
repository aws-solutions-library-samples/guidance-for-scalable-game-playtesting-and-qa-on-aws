const { GameLiftStreams, GetApplicationCommand } = require('@aws-sdk/client-gameliftstreams');

exports.handler = async function (event, context) {

    try {

        //this assumes that event looks like this -> {..."applicationSelected": "a-mm2eGo6iH"...}
        console.log("event: " + JSON.stringify(event.applicationSelected));
        const input = { // GetApplicationInput
            Identifier: event.applicationSelected, // required
        };

        const data = await new GameLiftStreams().send(new GetApplicationCommand(input));

        return {
            status: data.Status,
        };
    } catch (error) {
        return {
            status: 'ERROR'
        };
    }
};