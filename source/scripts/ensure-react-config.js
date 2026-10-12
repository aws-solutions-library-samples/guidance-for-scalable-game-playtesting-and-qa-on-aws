/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

/*
 * Ensures frontend/src/aws-config.generated.json exists.
 *
 * The generated config is gitignored (it holds live Cognito/API values after a deploy and
 * must never be committed). Because src/aws-config.ts imports it statically, a freshly cloned
 * repo would fail to compile if the file were absent. This script writes a placeholder default
 * ONLY when the file is missing, so a clean clone always builds. It never overwrites an
 * existing file, so real values written by a deploy are left untouched.
 */
const fs = require('fs');
const path = require('path');

const generatedConfigPath = path.join(__dirname, '../frontend/src/aws-config.generated.json');

const placeholder = {
    userPoolId: "USERPOOL_PLACEHOLDER",
    userPoolClientId: "CLIENTID_PLACEHOLDER",
    apiEndpoint: "API_ENDPOINT_PLACEHOLDER",
};

if (fs.existsSync(generatedConfigPath)) {
    console.log(`aws-config.generated.json already exists; leaving it untouched.`);
} else {
    fs.writeFileSync(generatedConfigPath, JSON.stringify(placeholder, null, 2) + '\n', 'utf-8');
    console.log(`Created placeholder ${generatedConfigPath}.`);
}
