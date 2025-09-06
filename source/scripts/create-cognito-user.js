const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand } = require("@aws-sdk/client-cloudformation");
const fs = require("fs");
const path = require("path");
require('dotenv').config();

// Function to generate a random temporary password
const generateTempPassword = () => {
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*';
    
    const getRandomChar = (characterSet) => {
        return characterSet[Math.floor(Math.random() * characterSet.length)];
    };

    let password = [
        getRandomChar(lowercase),  // at least one lowercase
        getRandomChar(uppercase),  // at least one uppercase
        getRandomChar(numbers),    // at least one number
        getRandomChar(symbols),    // at least one symbol
    ];

    const allChars = lowercase + uppercase + numbers + symbols;
    for (let i = password.length; i < 12; i++) {
        password.push(getRandomChar(allChars));
    }

    for (let i = password.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [password[i], password[j]] = [password[j], password[i]];
    }

    return password.join('');
};

// Initialize AWS clients
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.CDK_DEFAULT_REGION });
const cloudFormationClient = new CloudFormationClient({ region: process.env.CDK_DEFAULT_REGION });

// Stack names definition
const stackNames = {
    parent: 'PlaytestSolution',
    api: 'PlaytestingApiStack',
    frontend: 'PlaytestingFrontendStack'
};

// Helper function to wait for stack deletion
async function waitForStackDeletion(stackName) {
    while (true) {
        try {
            const command = new DescribeStacksCommand({
                StackName: stackName
            });
            
            await cloudFormationClient.send(command);
            
            // If we get here, stack still exists, wait and check again
            console.log(`Waiting for ${stackName} deletion...`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            
        } catch (error) {
            // If stack is not found, it's been deleted
            if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
                console.log(`Stack ${stackName} has been deleted`);
                return;
            }
            throw error; // Re-throw unexpected errors
        }
    }
}

async function performRollback() {
    console.log("\nInitiating stack rollback...");
    try {
        // Delete stacks in the correct order
        const stacksToDelete = [
            stackNames.api,
            stackNames.parent
        ];

        for (const stackName of stacksToDelete) {
            console.log(`\nDeleting stack: ${stackName}`);
            
            const deleteCommand = new DeleteStackCommand({
                StackName: stackName
            });

            await cloudFormationClient.send(deleteCommand);
            
            // Wait for stack deletion to complete
            await waitForStackDeletion(stackName);
        }

        console.log("\nStacks deleted successfully");
        
        // Create marker file
        fs.writeFileSync(
            path.join(__dirname, '../.deployment-failed'),
            'Cognito user creation failed, deployment halted and rollback completed'
        );
        
        return true;
    } catch (rollbackError) {
        console.error("Failed to rollback stacks:", rollbackError);
        console.log("\nManual cleanup may be required:");
        console.log("1. Use AWS Console or AWS CLI to destroy the stacks");
        console.log(`2. Stack names: ${Object.values(stackNames).join(', ')}`);
        console.log(`3. User Pool ID: ${userPoolId}`);
        
        fs.writeFileSync(
            path.join(__dirname, '../.deployment-failed'),
            'Cognito user creation failed, manual cleanup required'
        );
        
        return false;
    }
}

async function createUser() {
    // Get username and email from npm config
    const username = process.env.npm_config_user;
    const email = process.env.npm_config_email;

    try {
        // Validate arguments inside try block
        if (!username || !email) {
            throw new Error("Missing arguments. Run with --user=USERNAME --email=EMAIL");
        }

        // Read CDK outputs inside try block
        let userPoolId;
        try {
            const cdkOutputs = JSON.parse(fs.readFileSync(path.join(__dirname, "../cdk-outputs.json"), "utf8"));
            userPoolId = cdkOutputs[stackNames.api].UserPoolId;
            if (!userPoolId) throw new Error("User Pool ID not found in CDK outputs.");
        } catch (error) {
            throw new Error(`Error reading userPoolId from CDK outputs: ${error.message}`);
        }

        console.log(`Creating Cognito user: ${username}, ${email}`);

        const tempPassword = generateTempPassword();

        // Create the user
        await cognitoClient.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: username,
            TemporaryPassword: tempPassword,
            UserAttributes: [
                { Name: "email", Value: email },
                { Name: "email_verified", Value: "false" }
            ],
            MessageAction: "SUPPRESS"
        }));
        console.log(`User '${username}' created successfully.`);

        // Add the user to a group
        const groupName = "Admin";
        await cognitoClient.send(new AdminAddUserToGroupCommand({
            UserPoolId: userPoolId,
            Username: username,
            GroupName: groupName
        }));
        console.log(`User '${username}' added to group '${groupName}' successfully.`);

        // Log the temporary password
        console.log('\n=== IMPORTANT USER CREDENTIALS ===');
        console.log(`Username: ${username}`);
        console.log(`Temporary password: ${tempPassword}`);
        console.log('\nNOTE: User must change password on first login and verify their email address.');
        console.log('===============================');

        // Create a marker file to indicate successful completion
        fs.writeFileSync(
            path.join(__dirname, '../.deployment-success'),
            'Cognito user creation successful'
        );

    } catch (error) {
        console.error("\nError:", error.message);
        
        // Attempt rollback
        console.log("\nAttempting to rollback due to failure...");
        await performRollback();
        process.exit(1);
    }
}

// Execute the user creation with proper error handling
(async () => {
    try {
        await createUser();
    } catch (error) {
        console.error("Unhandled error:", error);
        await performRollback();
        process.exit(1);
    }
})();
