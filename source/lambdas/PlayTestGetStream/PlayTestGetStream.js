const { GameLiftStreams } = require('@aws-sdk/client-gameliftstreams');


function defaultHeader() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    };
}

exports.handler = async function (event, context) {
    const { sg, arn } = event.pathParameters || {};
    try {

        const gameLiftStreams = new GameLiftStreams({
            endpoint: process.env.GAMELIFTSTREAMS_OVERRIDE_ENDPOINT
        });

        let streamSession = await gameLiftStreams.getStreamSession({
            Identifier: decodeURIComponent(sg),
            StreamSessionIdentifier: decodeURIComponent(arn)
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
