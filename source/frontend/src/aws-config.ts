/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

/*
 * Centralized Amplify configuration for the frontend.
 *
 * Values are sourced from `aws-config.generated.json`, which is regenerated on every
 * deploy by `scripts/update-react-config.js` using the live CDK stack outputs.
 *
 * This file (and index.tsx) are NEVER mutated by the deploy process, which makes
 * destroy + redeploy fully idempotent: there is nothing to "reset" between deploys.
 *
 * The generated JSON ships with placeholder values in source control. A real deploy
 * overwrites it locally with the actual UserPool / client / API endpoint. The build
 * reads whatever is in the generated file at build time.
 */
import generated from "./aws-config.generated.json";

export const awsConfig = {
    Auth: {
        Cognito: {
            userPoolId: generated.userPoolId,
            userPoolClientId: generated.userPoolClientId,
        },
    },
    API: {
        REST: {
            "playtesting-api": {
                endpoint: generated.apiEndpoint,
            },
        },
    },
};

export default awsConfig;
