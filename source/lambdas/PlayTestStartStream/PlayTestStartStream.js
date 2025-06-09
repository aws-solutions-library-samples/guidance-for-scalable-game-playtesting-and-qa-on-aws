const { GameLiftStreams } = require('@aws-sdk/client-gameliftstreams');


function defaultHeader() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    };
}

exports.handler = async function (event, context) {

    const body = JSON.parse(event.body);
    try {

        const gameLiftStreams = new GameLiftStreams({
            endpoint: process.env.GAMELIFTSTREAMS_OVERRIDE_ENDPOINT
        });

        let streamSession = await gameLiftStreams.startStreamSession({
            Identifier: body.SGIdentifier,
            ApplicationIdentifier: body.AppIdentifier,
            Protocol: 'WebRTC', // current only supported Value
            UserId: body.UserId,
            SignalRequest: body.SignalRequest,
            //AdditionalLaunchArgs: 'AdditionalLaunchArgs' in metadata.Item ? metadata.Item.AdditionalLaunchArgs : null,
            //AdditionalEnvironmentVariables: 'AdditionalEnvironmentVariables' in metadata.Item ? metadata.Item.AdditionalEnvironmentVariables : null,
            ConnectionTimeoutSeconds: Number(process.env.CONNECTION_TIMEOUT || 120),
            Locations: body.Regions
        });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                ...defaultHeader()
            },
            body: JSON.stringify({
                signalResponse: streamSession.SignalResponse ?? '',
                arn: streamSession.Arn,
                region: streamSession.Location,
                status: streamSession.Status
            })
        };
    } catch (e) {
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                ...defaultHeader()
            },
            body: JSON.stringify({ 'message': e.message })
        };
    }
};
