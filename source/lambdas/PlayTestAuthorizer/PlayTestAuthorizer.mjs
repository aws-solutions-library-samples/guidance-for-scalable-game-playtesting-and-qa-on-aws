/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

/*
 * API Gateway REQUEST Lambda authorizer that enforces Cognito group-based access.
 *
 * Why this exists:
 *   The native Cognito authorizer only verifies that a caller is a valid, signed-in user.
 *   It does NOT consider which Cognito group the user belongs to, so (prior to this) any
 *   authenticated playtester could call admin-only endpoints (e.g. create/delete playtest
 *   sessions) by hitting the API directly. This authorizer closes that hole server-side.
 *
 * Model:
 *   - Admin group is a superset: Admins may call every authenticated route.
 *   - Playtester group may only call the playtester route set defined below.
 *   - Any other / missing group is denied.
 *
 * It verifies the Cognito JWT (signature, expiry, audience, token use) with aws-jwt-verify,
 * then returns an IAM policy that allows or denies the specific method ARN requested.
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";

// Verifier is created once per container for reuse (it caches the JWKS).
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID,
    tokenUse: "id",
    clientId: process.env.USER_POOL_CLIENT_ID,
});

/*
 * Playtester-allowed routes. Each entry is { method, path } where path is the API Gateway
 * resource path (NOT including the stage). "ANY" method matches any verb.
 * Admins bypass this list entirely (superset).
 */
const PLAYTESTER_ROUTES = [
    { method: "POST", path: "/" },                          // start stream
    { method: "GET", path: "/session/*" },                  // stream session status (/session/{sg}/{arn})
    { method: "POST", path: "/playtester" },                // submit observations
    { method: "GET", path: "/validate" },                   // validate playtester access
    { method: "GET", path: "/playtestsessionobservations" },// fetch observations for the session
    { method: "POST", path: "/GetStreamGroupRegions" },     // list available regions
];

/*
 * Parse an API Gateway method ARN:
 *   arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{httpVerb}/{resourcePath...}
 * Returns { verb, resourcePath } where resourcePath starts with "/".
 */
function parseMethodArn(methodArn) {
    const parts = methodArn.split(":");
    const apiGatewayArnPart = parts[5]; // {apiId}/{stage}/{verb}/{resource...}
    const segments = apiGatewayArnPart.split("/");
    const verb = segments[2];
    const resourcePath = "/" + segments.slice(3).join("/");
    return { verb, resourcePath };
}

/*
 * Returns true if the requested verb+path is in the playtester allow-list.
 * Supports a single trailing "*" wildcard segment (used for /session/{sg}/{arn}).
 */
function isPlaytesterAllowed(verb, resourcePath) {
    return PLAYTESTER_ROUTES.some((route) => {
        if (route.method !== "ANY" && route.method !== verb) {
            return false;
        }
        if (route.path.endsWith("/*")) {
            const prefix = route.path.slice(0, -1); // keep trailing slash before wildcard
            return resourcePath.startsWith(prefix);
        }
        // Normalize a possible trailing slash on the incoming path (e.g. "/validate/" === "/validate")
        const normalized = resourcePath.endsWith("/") && resourcePath.length > 1
            ? resourcePath.slice(0, -1)
            : resourcePath;
        return normalized === route.path;
    });
}

/*
 * Build an IAM policy document scoped to the SPECIFIC requested method ARN.
 *
 * IMPORTANT: We must NOT broaden the Allow resource to a wildcard covering the whole API.
 * API Gateway caches the authorizer result keyed only by the identity source (the
 * Authorization token), NOT by the method/resource. If we returned a broad wildcard Allow, a
 * playtester allowed on a playtester route would get that cached Allow reused for an admin
 * route too, bypassing the per-route decision. Scoping to the exact methodArn keeps each
 * route's decision correct even with caching enabled.
 */
function buildPolicy(principalId, effect, methodArn, context) {
    const resource = methodArn;

    return {
        principalId: principalId,
        policyDocument: {
            Version: "2012-10-17",
            Statement: [
                {
                    Action: "execute-api:Invoke",
                    Effect: effect,
                    Resource: resource,
                },
            ],
        },
        context: context || {},
    };
}

export const handler = async (event) => {
    const methodArn = event.methodArn;

    // Pull the bearer token from the Authorization header (REQUEST authorizer).
    const authHeader =
        event.headers?.Authorization ||
        event.headers?.authorization ||
        event.authorizationToken ||
        "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
        console.warn("No token provided; denying.");
        throw new Error("Unauthorized"); // API Gateway maps this to a 401
    }

    let payload;
    try {
        payload = await verifier.verify(token);
    } catch (err) {
        console.warn("JWT verification failed:", err?.message);
        throw new Error("Unauthorized"); // 401 for an invalid/expired token
    }

    const groups = payload["cognito:groups"] || [];
    const { verb, resourcePath } = parseMethodArn(methodArn);

    const isAdmin = groups.includes("Admin");
    const isPlaytester = groups.includes("Playtester");

    // Admin is a superset: allow everything.
    // Playtester: allow only the playtester route set.
    const allowed = isAdmin || (isPlaytester && isPlaytesterAllowed(verb, resourcePath));

    const context = {
        username: payload["cognito:username"] || payload.sub || "unknown",
        groups: Array.isArray(groups) ? groups.join(",") : String(groups),
    };

    if (!allowed) {
        console.warn(
            `Access denied for user=${context.username} groups=[${context.groups}] on ${verb} ${resourcePath}`
        );
        return buildPolicy(context.username, "Deny", methodArn, context);
    }

    return buildPolicy(context.username, "Allow", methodArn, context);
};
