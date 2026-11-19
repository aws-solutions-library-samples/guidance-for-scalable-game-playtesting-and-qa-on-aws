const { GameLiftStreams } = require('@aws-sdk/client-gameliftstreams');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const {
    opaqueUserId,
    registrationHash,
    newWatermarkSeed,
    watermarkEnvironment,
    sessionAlpha,
} = require('./streamWatermark');

const gameLiftStreams = new GameLiftStreams({
    endpoint: process.env.GAMELIFTSTREAMS_OVERRIDE_ENDPOINT
});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function defaultHeader() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    };
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            ...defaultHeader()
        },
        body: JSON.stringify(body)
    };
}

/*
 * Starts a playtester's stream.
 *
 * Who is streaming comes from the API authorizer (the verified Cognito username), never
 * from the request body, and the playtest session is derived server-side from the stream
 * group and application. A playtester must be registered for the session themselves;
 * admins may stream any existing session for testing. If the session has forensic
 * watermarking on, a fresh seed is minted and recorded against the streaming user BEFORE
 * the stream starts, so a watermarked stream always has a matching record.
 */
exports.handler = async function (event, context) {
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return respond(400, { message: 'Invalid request body.' });
    }
    if (!body.SGIdentifier || !body.AppIdentifier || !body.SignalRequest) {
        return respond(400, { message: 'SGIdentifier, AppIdentifier and SignalRequest are required.' });
    }

    const username = event.requestContext?.authorizer?.username;
    const groups = String(event.requestContext?.authorizer?.groups ?? '').split(',').filter(Boolean);
    if (!username || username === 'unknown') {
        return respond(403, { message: 'Could not determine who is signed in.' });
    }
    const isAdmin = groups.includes('Admin');

    // Session ids are "<stream group id>--<application id>" once the session is active.
    const playtestingID = `${body.SGIdentifier}--${body.AppIdentifier}`;
    let seed = null;

    try {
        const session = (await ddb.send(new GetCommand({
            TableName: process.env.PLAYTESTSESSION_TABLE,
            Key: { playtestingID }
        }))).Item;
        if (!session) {
            return respond(404, { message: "This playtest session doesn't exist." });
        }

        // Only the playtester a registration belongs to may stream with it.
        const playtesterID = registrationHash(username, playtestingID);
        if (!isAdmin) {
            const registration = (await ddb.send(new GetCommand({
                TableName: process.env.PLAYTESTERS_TABLE,
                Key: { playtesterID, playtestsessionID: playtestingID }
            }))).Item;
            if (!registration) {
                return respond(403, {
                    message: "You aren't registered for this playtest session. Register through the Discord bot to get your own playtest link."
                });
            }
        }

        let environment;
        if (session.watermarkEnabled === true) {
            // Decide the session variables from the application's real runtime, read
            // server-side. Fail closed: a watermarked session must never stream unmarked.
            let runtimeType;
            try {
                const app = await gameLiftStreams.getApplication({ Identifier: body.AppIdentifier });
                runtimeType = app.RuntimeEnvironment?.Type;
            } catch (e) {
                console.error('Watermark: could not read the application runtime', e?.name);
                return respond(503, { message: "Couldn't prepare the watermark for this stream. Please try again." });
            }

            const alpha = sessionAlpha(session);
            seed = newWatermarkSeed();
            environment = watermarkEnvironment(runtimeType, alpha, seed);
            if (!environment) {
                seed = null;
                console.error('Watermark: unsupported runtime for a watermarked session', runtimeType);
                return respond(409, { message: "This playtest session's game can't be watermarked, so it can't be streamed. Contact the studio." });
            }

            // Record the binding first. If this fails, nothing streams.
            await ddb.send(new PutCommand({
                TableName: process.env.WATERMARK_SEED_TABLE,
                Item: {
                    seed,
                    playtesterName: username,
                    playtesterID,
                    isAdmin,
                    playtestingID,
                    // Snapshots, so the record still reads correctly after the session is deleted.
                    sessionName: session.name ?? '',
                    game: session.game ?? '',
                    studio: session.studio ?? '',
                    streamGroupId: body.SGIdentifier,
                    applicationId: body.AppIdentifier,
                    runtimeType,
                    alpha,
                    createdAt: new Date().toISOString(),
                    sourceIp: event.requestContext?.identity?.sourceIp ?? '',
                    status: 'STARTING'
                },
                ConditionExpression: 'attribute_not_exists(seed)'
            }));
        }

        let streamSession;
        try {
            streamSession = await gameLiftStreams.startStreamSession({
                Identifier: body.SGIdentifier,
                ApplicationIdentifier: body.AppIdentifier,
                Protocol: 'WebRTC', // current only supported Value
                UserId: opaqueUserId(username),
                SignalRequest: body.SignalRequest,
                ...(environment ? { AdditionalEnvironmentVariables: environment } : {}),
                ConnectionTimeoutSeconds: Number(process.env.CONNECTION_TIMEOUT || 120),
                Locations: body.Regions
            });
        } catch (e) {
            // The stream never started, so its seed was never used: remove the record.
            if (seed) {
                await ddb.send(new DeleteCommand({ TableName: process.env.WATERMARK_SEED_TABLE, Key: { seed } }))
                    .catch((err) => console.error('Watermark: could not remove the unused seed record', err?.name));
            }
            throw e;
        }

        if (seed) {
            await ddb.send(new UpdateCommand({
                TableName: process.env.WATERMARK_SEED_TABLE,
                Key: { seed },
                UpdateExpression: 'SET streamSessionArn = :arn, #loc = :loc, #status = :status',
                ExpressionAttributeNames: { '#loc': 'location', '#status': 'status' },
                ExpressionAttributeValues: {
                    ':arn': streamSession.Arn ?? '',
                    ':loc': streamSession.Location ?? '',
                    ':status': 'STARTED'
                }
            })).catch((err) => console.error('Watermark: could not record the stream session on the seed record', err?.name));
        }

        // Only these fields go back to the browser. StartStreamSession echoes the
        // session variables, which include the watermark seed.
        return respond(200, {
            signalResponse: streamSession.SignalResponse ?? '',
            arn: streamSession.Arn,
            region: streamSession.Location,
            status: streamSession.Status
        });
    } catch (e) {
        return respond(500, { 'message': e.message });
    }
};
