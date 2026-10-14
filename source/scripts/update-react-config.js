/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

/*
 * Writes the live CDK stack outputs into frontend/src/aws-config.generated.json.
 *
 * This replaces the previous approach of string-replacing placeholders inside index.tsx.
 * Because we now write to a dedicated generated file (and never mutate source), the deploy
 * is fully idempotent: running deploy-all repeatedly (including after a destroy) always
 * produces correct config with no manual "reset" of index.tsx required.
 */
const fs = require('fs');
const path = require('path');

// Path to the CDK outputs file
const cdkOutputsPath = path.join(__dirname, '../cdk-outputs.json');

// Path to the generated frontend config consumed by src/aws-config.ts
const generatedConfigPath = path.join(__dirname, '../frontend/src/aws-config.generated.json');

try {
    // Load CDK Outputs
    const cdkOutputs = JSON.parse(fs.readFileSync(cdkOutputsPath, 'utf-8'));

    // Extract variables from stack output
    const userPoolId = cdkOutputs.PlaytestingApiStack.UserPoolId;
    const webClientId = cdkOutputs.PlaytestingApiStack.WebClientId;
    const apiURL = cdkOutputs.PlaytestingApiStack.Endpoint;

    if (!userPoolId) {
        throw new Error('UserPool ID not found in CDK outputs.');
    }
    if (!webClientId) {
        throw new Error('Web Client ID not found in CDK outputs.');
    }
    if (!apiURL) {
        throw new Error('API endpoint not found in CDK outputs.');
    }

    // Strip any trailing slash from the API URL
    const apiEndpoint = apiURL.replace(/\/$/, "");

    const generatedConfig = {
        userPoolId: userPoolId,
        userPoolClientId: webClientId,
        apiEndpoint: apiEndpoint,
    };

    fs.writeFileSync(generatedConfigPath, JSON.stringify(generatedConfig, null, 2) + '\n', 'utf-8');

    console.log(`Wrote ${generatedConfigPath} with UserPoolID: ${userPoolId}`);
} catch (error) {
    console.error('Error updating React config:', error);
    process.exit(1); // Ensure CDK fails if this step fails
}
