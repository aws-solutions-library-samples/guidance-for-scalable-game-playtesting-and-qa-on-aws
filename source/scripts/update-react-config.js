const fs = require('fs');
const path = require('path');

// Path to the CDK outputs file
const cdkOutputsPath = path.join(__dirname, '../cdk-outputs.json');

// Path to your React file
const reactFilePath = path.join(__dirname, '../frontend/src/index.tsx');

try {
    // Load CDK Outputs
    const cdkOutputs = JSON.parse(fs.readFileSync(cdkOutputsPath, 'utf-8'));

    // Extract variables from stack output
    const userPoolId = cdkOutputs.PlaytestingApiStack.UserPoolId;
    const webClientId = cdkOutputs.PlaytestingApiStack.WebClientId;
    const apiURL = cdkOutputs.PlaytestingApiStack.Endpoint;

    //need to strip the ending backslash from apiURL
    const apiURLWithoutBackslash = apiURL.replace(/\/$/, "");

    if (!userPoolId) {
        throw new Error('UserPool ID not found in CDK outputs.');
    }

    // Read and modify the React config file
    let fileContent = fs.readFileSync(reactFilePath, 'utf-8');
    fileContent = fileContent.replace('USERPOOL_PLACEHOLDER', userPoolId);
    fileContent = fileContent.replace('CLIENTID_PLACEHOLDER', webClientId);
    fileContent = fileContent.replace('API_ENDPOINT_PLACEHOLDER', apiURLWithoutBackslash);
    fs.writeFileSync(reactFilePath, fileContent, 'utf-8');

    console.log(`Updated ${reactFilePath} with UserPoolID: ${userPoolId}`);
} catch (error) {
    console.error('Error updating React config:', error);
    process.exit(1); // Ensure CDK fails if this step fails
}
