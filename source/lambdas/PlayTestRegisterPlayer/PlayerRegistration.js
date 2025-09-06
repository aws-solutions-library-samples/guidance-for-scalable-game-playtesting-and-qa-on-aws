import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { 
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from 'crypto';

const ssmClient = new SSMClient();
const dynamoDB = DynamoDBDocument.from(new DynamoDB());
const cognitoClient = new CognitoIdentityProviderClient();

// Function to generate a random temporary password
const generateTempPassword = () => {
    // Define character sets
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*';
    
    // Function to get random character from a string
    const getRandomChar = (characterSet) => {
        return characterSet[Math.floor(Math.random() * characterSet.length)];
    };

    // Ensure at least one of each required character type
    let password = [
        getRandomChar(lowercase),  // at least one lowercase
        getRandomChar(uppercase),  // at least one uppercase
        getRandomChar(numbers),    // at least one number
        getRandomChar(symbols),    // at least one symbol
    ];

    // Complete the rest of the password
    const allChars = lowercase + uppercase + numbers + symbols;
    for (let i = password.length; i < 12; i++) {
        password.push(getRandomChar(allChars));
    }

    // Shuffle the password array to make it random
    for (let i = password.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [password[i], password[j]] = [password[j], password[i]];
    }

    return password.join('');
};

const generateHash = (stringValue, salt) => {
    const hash = crypto
        .pbkdf2Sync(stringValue, salt, 1000, 64, "sha512")
        .toString("hex");
    return hash;
};


export const handler = async (event) => {
    try {
        let parameterName = "playtestURL";
        const withDecryption = true;

        const body = JSON.parse(event.body);
        const playtesterId = body.playtesterId;
        const playtestsessionId = body.playtestsessionId;
        const playtesterEmail = body.playtesterEmail;

        const hashedPlaytester = generateHash(playtesterId, playtestsessionId);
        const tempPassword = generateTempPassword();

        let isNewCognitoUser = false;
        let userExists = true;

        // Try to create Cognito user
        try {
            const createUserParams = {
                UserPoolId: process.env.COGNITO_USER_POOL_ID,
                Username: playtesterId,
                TemporaryPassword: tempPassword,
                UserAttributes: [
                    {
                        Name: 'email',
                        Value: playtesterEmail
                    },
                    {
                        Name: 'email_verified',
                        Value: 'false'
                    }
                ],
                MessageAction: 'SUPPRESS',
                DesiredDeliveryMediums: ['EMAIL']
            };

            await cognitoClient.send(new AdminCreateUserCommand(createUserParams));
            isNewCognitoUser = true;

            // Set password requirements
            const setPasswordParams = {
                UserPoolId: process.env.COGNITO_USER_POOL_ID,
                Username: playtesterId,
                Password: tempPassword,
                Permanent: false
            };

            await cognitoClient.send(new AdminSetUserPasswordCommand(setPasswordParams));

        } catch (cognitoError) {
            // If error is not "user exists", rethrow it
            if (!cognitoError.message.includes('User account already exists')) {
                throw cognitoError;
            }
            // User already exists - continue with the flow
            userExists = true;
        }

        // Get URL from Parameter Store
        let command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });

        let response = await ssmClient.send(command);
        const parameterStoreURL = response.Parameter?.Value;

        if (!playtesterId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: "Missing 'playtesterId' parameter in request body." }),
            };
        }

        // Check DynamoDB record
        const getParams = {
            TableName: process.env.PLAYTESTERS_TABLE,
            Key: {
                playtesterID: hashedPlaytester,
                playtestsessionID: playtestsessionId
            },
        };

        const result = await dynamoDB.get(getParams);
        let isNewDynamoDBRecord = false;

        if (!result.Item) {
            const putParams = {
                TableName: process.env.PLAYTESTERS_TABLE,
                Item: {
                    playtesterID: hashedPlaytester,
                    playtestsessionID: playtestsessionId,
                    playtesterName: playtesterId,
                    recordedObservations: ""
                },
            };

            await dynamoDB.put(putParams);
            isNewDynamoDBRecord = true;
        }

        // Prepare response based on different scenarios
        const baseResponse = {
            playtestURL: "https://" + parameterStoreURL + "/playtest?id=" + hashedPlaytester + "&sessionId=" + playtestsessionId,
        };

        let responseBody;

        if (isNewCognitoUser) {
            // New Cognito user created
            responseBody = {
                ...baseResponse,
                username: playtesterId,
                password: tempPassword,
                message: "Please check your email to verify your account. You will need to change your password on first login."
            };
        } else if (!isNewDynamoDBRecord) {
            // Both Cognito user and DynamoDB record exist
            responseBody = {
                ...baseResponse,
                message: "You have already registered for this playtest session. Please use your existing account to access the playtest."
            };
        } else {
            // Existing Cognito user but new DynamoDB record
            responseBody = {
                ...baseResponse,
                message: "You have been registered for this new playtest session. Please use your existing account credentials to access the playtest."
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify(responseBody),
        };

    } catch (error) {
        console.error("Error processing request:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                message: "Internal Server Error", 
                error: error.message 
            }),
        };
    }
};

