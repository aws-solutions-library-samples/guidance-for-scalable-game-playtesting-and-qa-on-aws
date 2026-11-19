const crypto = require('crypto');
const { GameLiftStreams } = require('@aws-sdk/client-gameliftstreams');

const gameLiftStreams = new GameLiftStreams({
    endpoint: process.env.GAMELIFTSTREAMS_OVERRIDE_ENDPOINT
});

function defaultHeader() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    };
}

/**
 * Opaque GameLift Streams UserId for a signed-in user. Must match opaqueUserId() in
 * PlayTestStartStream/streamWatermark.js, which stamps it on the session at start.
 */
function opaqueUserId(username) {
    return "u" + crypto.createHash("sha256").update(String(username)).digest("hex").slice(0, 16);
}

/**
 * True if the caller may see this stream session. Sessions are stamped with the
 * starting user's opaque id, so one user can never poll or reconnect to another user's
 * (possibly watermarked) session. Sessions with no UserId predate this check.
 */
function ownsSession(sessionUserId, username) {
    if (!sessionUserId) return true;
    return !!username && sessionUserId === opaqueUserId(username);
}

exports.handler = async function (event, context) {
    const { sg, arn } = event.pathParameters || {};
    const username = event.requestContext?.authorizer?.username;
    try {
        let streamSession = await gameLiftStreams.getStreamSession({
            Identifier: decodeURIComponent(sg),
            StreamSessionIdentifier: decodeURIComponent(arn)
        });

        if (!ownsSession(streamSession.UserId, username)) {
            return {
                statusCode: 403,
                headers: {
                    'Content-Type': 'application/json',
                    ...defaultHeader()
                },
                body: JSON.stringify({ message: 'This stream session belongs to another user.' })
            };
        }

        // Only these fields go back to the browser. GetStreamSession also echoes the
        // session variables, which include the forensic watermark seed.
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

// Exported for unit tests.
exports.opaqueUserId = opaqueUserId;
exports.ownsSession = ownsSession;
