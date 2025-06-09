const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand } = require("@aws-sdk/client-cognito-identity-provider");
const fs = require("fs");
const path = require("path");

// Read the CDK output file to get the User Pool ID
const cdkOutputPath = path.join(__dirname, "../cdk-outputs.json"); // Adjust path if needed

let userPoolId;
try {
    const cdkOutputs = JSON.parse(fs.readFileSync(cdkOutputPath, "utf8"));
    const stackName = Object.keys(cdkOutputs)[0]; // Assumes first stack contains the userPoolId
    userPoolId = cdkOutputs[stackName].UserPoolId; // Adjust this key based on your CDK output
    if (!userPoolId) throw new Error("User Pool ID not found in CDK outputs.");
} catch (error) {
    console.error("Error reading userPoolId from CDK outputs:", error);
    process.exit(1);
}

// Get other command-line arguments
const username = process.env.npm_config_user;
const password = process.env.npm_config_password;
const email = process.env.npm_config_email;

//get playtest username and password arguments
const playtestUsername = process.env.npm_config_PTuser;
const playtestPassword = process.env.npm_config_PTpassword;
const playtestEmail = process.env.npm_config_PTemail;

console.log(password);

if (!username || !password || !email) {
    console.error("Error: Missing arguments. Run with --user=USERNAME --password=PASSWORD --email=EMAIL");
    process.exit(1);
}

if (!playtestUsername || !playtestPassword || !playtestEmail) {
    console.error("Error: Missing arguments. Run with --PTuser=USERNAME --PTpassword=PASSWORD --PTemail=EMAIL");
    process.exit(1);
}

console.log(`Creating Cognito user: ${username}, ${email}`);

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.CDK_DEFAULT_REGION });

async function createUser() {
    try {
        // Step 1: Create the user
        await cognitoClient.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: username,
            UserAttributes: [
                { Name: "email", Value: email },
                { Name: "email_verified", Value: "true" }
            ]
        }));
        console.log(`User '${username}' created successfully.`);

        // Step 2: Set a permanent password
        await cognitoClient.send(new AdminSetUserPasswordCommand({
            UserPoolId: userPoolId,
            Username: username,
            Password: password,
            Permanent: true
        }));

        //Do it again for Playtester
        await cognitoClient.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: playtestUsername,
            UserAttributes: [
                { Name: "email", Value: playtestEmail },
                { Name: "email_verified", Value: "true" }
            ]
        }));
        console.log(`PTUser '${playtestUsername}' created successfully.`);

        // Step 2: Set a permanent password
        await cognitoClient.send(new AdminSetUserPasswordCommand({
            UserPoolId: userPoolId,
            Username: playtestUsername,
            Password: playtestPassword,
            Permanent: true
        }));

        console.log(`Password set successfully for '${playtestUsername}'.`);
    } catch (error) {
        console.error("Error:", error);
    }
}

createUser();
