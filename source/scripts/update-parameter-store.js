const { SSMClient, PutParameterCommand } = require("@aws-sdk/client-ssm");
const fs = require("fs");
const path = require("path");
require('dotenv').config();

// AWS SDK Client
const ssmClient = new SSMClient({ region: process.env.CDK_DEFAULT_REGION });

async function updateParameterStore() {
    try {

        // Path to cdk-outputs.json (relative to the CDK execution)
        const outputsPath = path.join(__dirname, "../cdk-outputs.json");

        // Read the file
        if (!fs.existsSync(outputsPath)) {
            console.error("cdk-outputs.json not found! Ensure CDK deployment is complete.");
            process.exit(1);
        }

        const outputs = JSON.parse(fs.readFileSync(outputsPath, "utf-8"));

        // Extract the CloudFront URL (adjust the key based on your stack's output name)
        const stackName = "PlaytestingFrontendStack"; // <-- Change this to your frontend stack name
        const parameterName = "playtestURL";

        const cloudFrontURL = outputs[stackName]?.CloudFrontDomain;
        if (!cloudFrontURL) {
            console.error("CloudFrontDistributionURL not found in CDK outputs!");
            process.exit(1);
        }

        console.log(`Updating Parameter Store: ${parameterName} -> ${cloudFrontURL}`);

        // Update Parameter Store
        let command = new PutParameterCommand({
            Name: parameterName,
            Value: cloudFrontURL,
            Type: "String",
            Overwrite: true,
        });

        await ssmClient.send(command);
        console.log(`Successfully updated ${parameterName} in AWS Parameter Store.`);

    } catch (error) {
        console.error("Error updating Parameter Store:", error);
        process.exit(1);
    }
}

updateParameterStore();
