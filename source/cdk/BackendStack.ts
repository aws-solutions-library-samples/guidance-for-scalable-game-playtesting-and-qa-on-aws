/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import * as cdk from 'aws-cdk-lib';
import {CfnOutput, Duration, RemovalPolicy} from 'aws-cdk-lib';
import {Construct} from 'constructs';

import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ddb from 'aws-cdk-lib/aws-dynamodb'
import {AttributeType, BillingMode} from 'aws-cdk-lib/aws-dynamodb'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as log from 'aws-cdk-lib/aws-logs'
import {RetentionDays} from 'aws-cdk-lib/aws-logs'
import { NagSuppressions } from "cdk-nag";
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

export class PlaytestingApiStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // create the cognito user pool
        const userPool = this.createAuth();

        const playtestingtable = this.createPlaytestingTable();

        const playtestertable = this.createPlaytesterTable();

        //Create StepFunctions
        const steplFunction = this.createStepFunctions(playtestingtable);

        // create an API Gateway with 2 endpoints and 1 stage
        // 1. endpoint allows to start stream sessions
        // 2. endpoint allows to get the available games from the meta data table
        const stage = this.createRestAPI(userPool, playtestertable, playtestingtable, steplFunction);
        // attach a WAF ACL to the stage with basic rule sets to protect
        // The API
        this.createWebACL(stage);

        //Store CloudFront URL in AWS Systems Manager Parameter Store
        new ssm.StringParameter(this, "CloudFrontURLParameter", {
            parameterName: "playtestURL", // SSM parameter name
            stringValue: `https://TEMP_URL/`, // Store CloudFront URL
            description: "CloudFront Distribution URL for the SPA",
            tier: ssm.ParameterTier.STANDARD,
        });

        //Store a username and password for playtesters in parameterstore
        new ssm.StringParameter(this, "PlaytestUsername", {
            parameterName: "playtestUsername", // SSM parameter name
            stringValue: "REPLACE_USER", // Store CloudFront URL
            description: "Username for the playtest",
            tier: ssm.ParameterTier.STANDARD,
        });
        new ssm.StringParameter(this, "PlaytestPassword", {
            parameterName: "playtestPassword", // SSM parameter name
            stringValue: "REPLACE_PASSWORD", // Store CloudFront URL
            description: "Username for the playtest",
            tier: ssm.ParameterTier.STANDARD,
        });
    }

    //Section of code that creates any stepfunctions
    private createStepFunctions(playtestsessiontable: ddb.Table): sfn.StateMachine {
        // Lambda to update DynamoDB status to ERROR
        const StepFunctionUpdateStatusLambda = new lambda.Function(this, 'StepFunctionUpdateStatusLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            code: lambda.Code.fromAsset('lambdas/PlayTestStepFunctionUpdateStatus'), // path to your lambda function
            handler: 'PlayTestStepFunctionUpdateStatus.handler',
            timeout: Duration.seconds(30),
            environment: {
                "PLAYTESTSESSION_TABLE": playtestsessiontable.tableName
            }
        });

        //Lambda to call GameLift Streams GetApplication
        const StepFunctionGetApplicationLambda = new lambda.Function(this, 'PlayTestGetGLAppStatus', {
            runtime: lambda.Runtime.NODEJS_22_X,
            code: lambda.Code.fromAsset('lambdas/PlayTestGetGLAppStatus'), // path to your lambda function
            handler: 'PlayTestGetGLAppStatus.handler',
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "GAMELIFT_REGION": 'us-east-2'
            }
        });

        //need to create lambda function that creates a stream gorup
        const StepFunctionCreateStreamGroupLambda = new lambda.Function(this, 'PlayTestStepFunctionCreateStreamGroupLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestStepFunctionCreateStreamGroup.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestStepFunctionCreateStreamGroup'),
            timeout: cdk.Duration.seconds(10), // Lower timeout to prevent resource exhaustion
        });

        //function to check for when stream group is finished creating
        const getStreamGroupStatusLambda = new lambda.Function(this, 'PlayTestStepFunctionGetSreamGroupLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestStepFunctionGetSreamGroup.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestStepFunctionGetSreamGroup'),
        });

        const associateApplicationLambda = new lambda.Function(this, 'PlayTestAssociateApplicationLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestAssociateApplication.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestAssociateApplication'),
        });

        associateApplicationLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:AssociateApplications"],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }))

        getStreamGroupStatusLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:GetStreamGroup"],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }))

        StepFunctionCreateStreamGroupLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:CreateStreamGroup"],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }))

        //I need to add more permissions to the policy for gamelift streams
        StepFunctionGetApplicationLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:GetApplication"],
            resources: ["arn:aws:gameliftstreams:*"]
        }))

        // grant read rights to metadata table
        playtestsessiontable.grantReadData(StepFunctionUpdateStatusLambda)

        //I need to add more permissions to the policy for dynamodb:PutItem action
        StepFunctionUpdateStatusLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
            resources: [playtestsessiontable.tableArn]
        }))

        // === LAMBDA TASKS ===

        const getAppStatus = new tasks.LambdaInvoke(this, 'GetApplicationStatus', {
            lambdaFunction: StepFunctionGetApplicationLambda,
            resultPath: '$.status',
            payloadResponseOnly: true,
        });

        const createStreamGroup = new tasks.LambdaInvoke(this, 'CreateStreamGroup', {
            lambdaFunction: StepFunctionCreateStreamGroupLambda,
            resultPath: '$.streamGroup',
            payloadResponseOnly: true,
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
        });

        const getStreamGroupStatusInitial = new tasks.LambdaInvoke(this, 'GetStreamGroupStatusInitial', {
            lambdaFunction: getStreamGroupStatusLambda,
            resultPath: '$.streamGroupStatus',
            payloadResponseOnly: true,
        });

        const getStreamGroupStatusLoop = new tasks.LambdaInvoke(this, 'GetStreamGroupStatusLoop', {
            lambdaFunction: getStreamGroupStatusLambda,
            resultPath: '$.streamGroupStatus',
            payloadResponseOnly: true,
        });

        const updateErrorStatus = new tasks.LambdaInvoke(this, 'UpdateErrorStatus', {
            lambdaFunction: StepFunctionUpdateStatusLambda,
            payload: sfn.TaskInput.fromObject({
                playtestingID: sfn.JsonPath.stringAt('$.newPlaytestingID'),
                status: 'ERROR',
            }),
        });

        const updateSuccessStatus = new tasks.LambdaInvoke(this, 'UpdateSuccessStatus', {
            lambdaFunction: StepFunctionUpdateStatusLambda,
            payload: sfn.TaskInput.fromObject({
                playtestingID: sfn.JsonPath.stringAt('$.newPlaytestingID'),
                status: 'ACTIVE',
                streamGroupID: sfn.JsonPath.stringAt('$.streamGroup.Id'),
                applicationID: sfn.JsonPath.stringAt('$.applicationSelected')
            }),
        });

        const associateApplicationStep = new tasks.LambdaInvoke(this, 'AssociateApplication', {
            lambdaFunction: associateApplicationLambda,
            outputPath: '$.Payload',
        });


        // === WAIT STATES ===

        const waitBeforeRetryInitial = new sfn.Wait(this, 'WaitBeforeRetryInitial', {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(60)),
        });

        const waitForStreamGroupActive = new sfn.Wait(this, 'WaitForStreamGroupActive', {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(60)),
        });

        // === STREAM GROUP STATUS RE-CHECK LOOP ===

        const checkStreamGroupStatusLoop = new sfn.Choice(this, 'CheckStreamGroupStatusLoop');

        checkStreamGroupStatusLoop
            .when(sfn.Condition.stringEquals('$.streamGroupStatus.status', 'ACTIVE'), associateApplicationStep.next(updateSuccessStatus))
            .when(sfn.Condition.stringEquals('$.streamGroupStatus.status', 'ERROR'), updateErrorStatus)
            .otherwise(waitForStreamGroupActive
                    .next(getStreamGroupStatusLoop)
                    .next(checkStreamGroupStatusLoop)
            );

        // === AFTER CREATE: FIRST STATUS CHECK ===

        const afterCreateStreamGroup = createStreamGroup
            .next(getStreamGroupStatusInitial)
            .next(checkStreamGroupStatusLoop);

        // === INITIAL STATUS CHECK ===

        const checkInitialStatus = new sfn.Choice(this, 'CheckInitialAppStatus');

        checkInitialStatus
            .when(sfn.Condition.stringEquals('$.status.status', 'READY'), afterCreateStreamGroup)
            .when(sfn.Condition.stringEquals('$.status.status', 'ERROR'), updateErrorStatus)
            .otherwise(waitBeforeRetryInitial
                .next(new tasks.LambdaInvoke(this, 'GetAppStatusRetry', {
                    lambdaFunction: StepFunctionGetApplicationLambda,
                    resultPath: '$.status',
                    payloadResponseOnly: true,
                }))
                .next(checkInitialStatus)
            );

        // === STATE MACHINE DEFINITION ===

        const definition = getAppStatus.next(checkInitialStatus);

       const stepFunction = new sfn.StateMachine(this, 'PlayTestingGameLiftStreamSetup', {
           definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.minutes(15),
        });



        //Suppressions
        NagSuppressions.addResourceSuppressions(associateApplicationLambda.role!, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Uses AWS managed policy for basic Lambda execution � acceptable for this utility function.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard is used for DynamoDB resource access; acceptable for internal table updates.'
            }
        ], true);
        NagSuppressions.addResourceSuppressions(getStreamGroupStatusLambda.role!, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Uses AWS managed policy for basic Lambda execution � acceptable for this utility function.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard is used for DynamoDB resource access; acceptable for internal table updates.'
            }
        ], true);
        NagSuppressions.addResourceSuppressions(StepFunctionCreateStreamGroupLambda.role!, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Uses AWS managed policy for basic Lambda execution � acceptable for this utility function.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard is used for DynamoDB resource access; acceptable for internal table updates.'
            }
        ], true);
        NagSuppressions.addResourceSuppressions(StepFunctionUpdateStatusLambda.role!, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Uses AWS managed policy for basic Lambda execution � acceptable for this utility function.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard is used for DynamoDB resource access; acceptable for internal table updates.'
            }
        ], true);
        NagSuppressions.addResourceSuppressions(StepFunctionGetApplicationLambda.role!, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'Uses AWS managed policy for basic Lambda execution � acceptable for this utility function.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard is used for DynamoDB resource access; acceptable for internal table updates.'
            }
        ], true);
        NagSuppressions.addResourceSuppressionsByPath(this, '/PlaytestingApiStack/PlayTestingGameLiftStreamSetup/Resource', [
            {
                id: 'AwsSolutions-SF1',
                reason: 'Logging not required for setup state machine in current environment.'
            },
            {
                id: 'AwsSolutions-SF2',
                reason: 'X-Ray tracing not required for non-production workflow.'
            }
        ]);
        NagSuppressions.addResourceSuppressionsByPath(this, '/PlaytestingApiStack/PlayTestingGameLiftStreamSetup/Role/DefaultPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Lambda invoke permissions require wildcard resource in Step Functions.'
            }
        ]);


        //return
        return stepFunction;
    }

    private createPlaytesterTable() {
        const table = new ddb.Table(this, "playtesters", {
            partitionKey: { name: "playtesterID", type: AttributeType.STRING },
            sortKey: { name: "playtestsessionID", type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY
        })

        new CfnOutput(this, "PlayTesterTableName", {
            value: table.tableName
        });

        NagSuppressions.addResourceSuppressions(table, [
            {
                id: 'AwsSolutions-DDB3',
                reason: 'Point in time recovery is not required as the DDB only contains easy to restore meta information for a demo.'
            }
        ]);

        return table;
    }

    private createPlaytestingTable() {
        const table = new ddb.Table(this, "playtestingsessions", {
            partitionKey: { name: "playtestingID", type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY
        })

        //I need to create a GSI on playtestsessionID with the name playtestsessionID-index
        table.addGlobalSecondaryIndex({
            indexName: "playtestsessionID-index",
            partitionKey: { name: "playtestsessionID", type: AttributeType.STRING }
        });

        new CfnOutput(this, "Playtesting-Session-Table-Name", {
            value: table.tableName
        });

        NagSuppressions.addResourceSuppressions(table, [
            {
                id: 'AwsSolutions-DDB3',
                reason: 'Point in time recovery is not required as the DDB only contains easy to restore meta information for a demo.'
            }
        ]);

        return table;
    }

    private createAuth() {
        const userPool = new cognito.UserPool(this, 'playtesting-user-pool', {
            userPoolName: this.stackName + '-user-pool',
            selfSignUpEnabled: false,
            removalPolicy: RemovalPolicy.DESTROY,
            passwordPolicy: {
                minLength: 8,
                requireDigits: true,
                requireLowercase: true,
                requireSymbols: true,
                requireUppercase: true
            },
        });

        // Create groups
        const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
            userPoolId: userPool.userPoolId,
            groupName: 'Admin',
            description: 'Admins of the application',
        });

        const playtesterGroup = new cognito.CfnUserPoolGroup(this, 'PlaytesterGroup', {
            userPoolId: userPool.userPoolId,
            groupName: 'Playtester',
            description: 'Playtesters of the application',
        });

        const userPoolClient = new cognito.UserPoolClient(this, 'playtesting-user-pool-client', {
            userPool: userPool,
            authFlows: {userPassword: true, userSrp: true},
            refreshTokenValidity: Duration.hours(1),
            idTokenValidity: Duration.minutes(5),
            accessTokenValidity: Duration.minutes(5),
            preventUserExistenceErrors: true,  // Helps prevent user enumeration
            enableTokenRevocation: true,  // Allows revoking tokens if compromise is detected
        })

        new CfnOutput(this, "User-Pool-Id", {
            value: userPool.userPoolId,
        });
        new CfnOutput(this, "WebClient-Id", {
            value: userPoolClient.userPoolClientId
        });

        NagSuppressions.addResourceSuppressions(userPool, [
            {id: 'AwsSolutions-COG2', reason: 'For demo purpose MFA is not required.'},
            {
                id: 'AwsSolutions-COG3',
                reason: 'For demo purpose AdvancedSecurityMode is potentially hindering development cycles.'
            },
        ]);

        return userPool;
    }

    private createRestAPI(userPool: cognito.UserPool, playtestertable: ddb.Table, playtestsessiontable: ddb.Table, stepFunction: sfn.StateMachine) {
        // create a Cognito Authorizer for our API
        const auth = new apigateway.CognitoUserPoolsAuthorizer(this, 'playtesting-authorized', {
            cognitoUserPools: [userPool]
        });

        const api = new apigateway.RestApi(this, 'playtesting-api', {
            restApiName: this.stackName + '-playtesting-api',
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS // this is also the default
            },
            deploy: false,
            cloudWatchRole: true
        });

        // add cors header to default 504 response for integration timeouts
        api.addGatewayResponse("gw-timeout-cors-headers", {
            type: apigateway.ResponseType.INTEGRATION_TIMEOUT,
            statusCode: "504",
            responseHeaders: {
                'Access-Control-Allow-Origin': "'*'",
                'Access-Control-Allow-Headers': "'*'",
                'Access-Control-Allow-Methods': "'*'"
            }
        })

        const lambdaLogGroup = new log.LogGroup(this, "LambdaLogGroup", {
            logGroupName: this.stackName + "/lambdas",
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY
        })

        const PTGLStreamLambda = new lambda.Function(this, 'PTGLStreamLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestStartStream.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestStartStream'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "CONNECTION_TIMEOUT": "10"
            },
            logGroup: lambdaLogGroup
        });

        // allow the lambda to start stream sessions of any SG
        // allow to get stream sessions to validate if they are active
        PTGLStreamLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:StartStreamSession", "gameliftstreams:GetStreamSession"],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`]
        }))

        // add the lambda as post action
        api.root.addMethod('POST', new apigateway.LambdaIntegration(PTGLStreamLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        ////
        //adding get stream session below
        ////

        const session = api.root.addResource('session');
        const sgParam = session.addResource('{sg}');
        const arnParam = sgParam.addResource('{arn}');

        // list all available games from DynamoDB
        const getStreamSessionLambda = new lambda.Function(this, 'gamelift-streams-get-stream-session-lambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestGetStream.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestGetStream'),
            timeout: cdk.Duration.seconds(10),
            logGroup: lambdaLogGroup
        });

        getStreamSessionLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['gameliftstreams:GetStreamSession'],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }));

        arnParam.addMethod('GET', new apigateway.LambdaIntegration(getStreamSessionLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO
        });



        ////
        //adding register ednpoint below
        ////

        const register = api.root.addResource("register")

        // register a playtester
        const registerPlayer = new lambda.Function(this, 'PlaytesterRegister', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayerRegistration.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestRegisterPlayer'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "PLAYTESTERS_TABLE": playtestertable.tableName
            },
            logGroup: lambdaLogGroup
        });
        // grant read rights to metadata table
        playtestertable.grantReadData(registerPlayer)

        //add more permissions to the policy
        registerPlayer.addToRolePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
            actions: ["ssm:GetParameter"],
                resources: [`arn:aws:ssm:*:${this.account}:*`]
        }))

        //I need to add more permissions to the policy for dynamodb:PutItem action
        registerPlayer.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:PutItem"],
            resources: [playtestertable.tableArn]
        }))

        //I need to add a post method called /register that uses a apikey but no authorization
        register.addMethod('POST', new apigateway.LambdaIntegration(registerPlayer), {
            apiKeyRequired: true
        });

        /////
        //Adding get method for generating AI Summary below
        /////

        const aiSummary = api.root.addResource("aisummary")

        // generate summary
        const generateAISummaryLambda = new lambda.Function(this, 'PlaytestGenerateSummary', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlaytestGenerateSummary.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestGenerateSummary'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            logGroup: lambdaLogGroup
        });

        //I need to add more permissions to the policy for bedrock:InvokeModel
        generateAISummaryLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["bedrock:InvokeModel"],
            resources: ["*"]
        }))

        //I need to add a get method called /PlaytestGenerateSummary
        aiSummary.addMethod('POST', new apigateway.LambdaIntegration(generateAISummaryLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        /////
        //Adding get method for getting S3 Buckets
        /////

        const getS3Buckets = api.root.addResource("GetS3Buckets")

        // get buckets
        const getBucketsLambda = new lambda.Function(this, 'GetBucketsLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestGetBuckets.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestGetBuckets'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            logGroup: lambdaLogGroup
        });

        //I need to add more permissions to the policy for retriving S3 Buckets
        getBucketsLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:Get*", "s3:List*", "s3:Describe*", "s3-object-lambda:Get*", "s3-object-lambda:List*"],
            resources: ["*"]
        }))

        //I need to add a get method called /PlaytestGenerateSummary
        getS3Buckets.addMethod('GET', new apigateway.LambdaIntegration(getBucketsLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        /////
        //Adding get method for getting Objects within a bucket
        /////

        const getS3BucketObjects = api.root.addResource("GetS3BucketObjects")

        // get buckets
        const getBucketObjectsLambda = new lambda.Function(this, 'GetBucketObjectsLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestGetBucketObjects.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestGetBucketObjects'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            logGroup: lambdaLogGroup
        });

        //I need to add more permissions to the policy for retriving S3 Buckets
        getBucketObjectsLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:Get*", "s3:List*", "s3:Describe*", "s3-object-lambda:Get*", "s3-object-lambda:List*"],
            resources: ["*"]
        }))

        //I need to add a get method called /PlaytestGenerateSummary
        getS3BucketObjects.addMethod('POST', new apigateway.LambdaIntegration(getBucketObjectsLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        /////
        ///Adding get and post playtester below
        /////

        const playtester = api.root.addResource("playtester")   

        // register a playtester
        const playtesters = new lambda.Function(this, 'Playtesters', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'Playtesters.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTesters'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "PLAYTESTERS_TABLE": playtestertable.tableName
            },
            logGroup: lambdaLogGroup
        });
        // grant read rights to metadata table
        playtestertable.grantReadData(playtesters)

        //I need to add more permissions to the policy for dynamodb:PutItem action
        playtesters.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
            resources: [playtestertable.tableArn]
        }))

        //I need to add a post method called /playtesters
        playtester.addMethod('POST', new apigateway.LambdaIntegration(playtesters), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        //I need to add a get method called /playtesters
        playtester.addMethod('GET', new apigateway.LambdaIntegration(playtesters), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });


        ////
        //adding validate ednpoint below
        ////

        const validate = api.root.addResource("validate")

        // validate a playtester
        const validatePlayer = new lambda.Function(this, 'PlaytesterValidate', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayerValidate.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTesterValidation'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "PLAYTESTERS_TABLE": playtestertable.tableName
            },
            logGroup: lambdaLogGroup
        });
        // grant read rights to metadata table
        playtestertable.grantReadData(validatePlayer)

        //I need to add more permissions to the policy for dynamodb:GetItem action
        validatePlayer.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:GetItem"],
            resources: [playtestertable.tableArn]
        }))

        //I need to add a post method called /validate that uses a apikey but no authorization
        validate.addMethod('GET', new apigateway.LambdaIntegration(validatePlayer), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });


        /////
        ///Adding get and post playtest sessions below
        /////

        const playtestSession = api.root.addResource("playtestsession")

        // setting up lambda
        const playtestSessionLambda = new lambda.Function(this, 'PlayTestSessionsLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestSessions.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestSessions'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "PLAYTESTSESSION_TABLE": playtestsessiontable.tableName,
                "STEP_FUNCTION_ARN":  stepFunction.stateMachineArn
            },
            logGroup: lambdaLogGroup
        });

        //grant start execution rights to lambda
        stepFunction.grantStartExecution(playtestSessionLambda)

        // grant read rights to metadata table
        playtestsessiontable.grantReadData(playtestSessionLambda)

        //I need to add more permissions to the policy for dynamodb:PutItem action
        playtestSessionLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
            resources: [playtestsessiontable.tableArn]
        }))

        //Add more to policy for GL Streams
        playtestSessionLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['gameliftstreams:CreateApplication', 'gameliftstreams:DeleteStreamGroup'],
            resources: [`arn:aws:gameliftstreams:*:${this.account}:*`] // hardened to account level
        }));

        //seems like GL streams may need S3 access as well
        playtestSessionLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:Get*", "s3:List*", "s3:Describe*", "s3-object-lambda:Get*", "s3-object-lambda:List*"],
            resources: ["*"]
        }))

        //I need to add a post method called /playtestsessions
        playtestSession.addMethod('POST', new apigateway.LambdaIntegration(playtestSessionLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        //I need to add a put method called /playtestsessions
        playtestSession.addMethod('PUT', new apigateway.LambdaIntegration(playtestSessionLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        //I need to add a delete method
        playtestSession.addMethod('DELETE', new apigateway.LambdaIntegration(playtestSessionLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        //I need to add a get method called /playtestsessions
        playtestSession.addMethod('GET', new apigateway.LambdaIntegration(playtestSessionLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        /////
        ///Adding get for playtest session observations
        /////

        const playtestSessionObservations = api.root.addResource("playtestsessionobservations")

        //setting up lambda
        const playtestSessionObsLambda = new lambda.Function(this, 'playtestSessionObsLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestObservations.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestObservations'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            environment: {
                "PLAYTESTSESSION_TABLE": playtestsessiontable.tableName
            },
            logGroup: lambdaLogGroup
        });
        // grant read rights to metadata table
        playtestsessiontable.grantReadData(playtestSessionObsLambda)

        //I need to add more permissions to the policy for dynamodb:PutItem action
        playtestSessionObsLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["dynamodb:PutItem", "dynamodb:GetItem"],
            resources: [playtestsessiontable.tableArn]
        }))

        //I need to add a get method called /playtestsessions
        playtestSessionObservations.addMethod('GET', new apigateway.LambdaIntegration(playtestSessionObsLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });

        /////
        ///Adding get for getting GL Streams applications
        /////

        const playtestListGLApplications = api.root.addResource("playtestListGLApplications")

        //setting up lambda
        const PlayTestGLSListApplicationsLambda = new lambda.Function(this, 'PlayTestGLSListApplicationsLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'PlayTestGLSListApplications.handler',
            code: lambda.Code.fromAsset('lambdas/PlayTestGLSListApplications'),
            timeout: Duration.seconds(10), // Lower timeout to prevent resource exhaustion
            logGroup: lambdaLogGroup
        });

        //I need to add more permissions to the policy for dynamodb:PutItem action
        PlayTestGLSListApplicationsLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["gameliftstreams:ListApplications"],
            resources: ["arn:aws:gameliftstreams:*"]
        }))

        //I need to add a get method
        playtestListGLApplications.addMethod('GET', new apigateway.LambdaIntegration(PlayTestGLSListApplicationsLambda), {
            authorizer: auth,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });



        const deployment = new apigateway.Deployment(this, 'apigw-deployment', {api})

        // enable logging for the stage
        const devLogGroup = new log.LogGroup(this, "DevLogs", {
            logGroupName: this.stackName + "/api-gw",
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY
        });
        const stage = new apigateway.Stage(this, 'prod', {
            deployment,
            accessLogDestination: new apigateway.LogGroupLogDestination(devLogGroup),
            accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                caller: false,
                httpMethod: true,
                ip: true,
                protocol: true,
                requestTime: true,
                resourcePath: true,
                responseLength: true,
                status: true,
                user: false,
            }),
            throttlingRateLimit: 1000,    // Global steady state
            throttlingBurstLimit: 2000,   // Global burst
        });

        new CfnOutput(this, "Endpoint", {
            value: stage.urlForPath("/"),
        });

        //I need to create an apikey that will be used with my api
        const apiKey = new apigateway.ApiKey(this, 'playtesting-api-key', {
            apiKeyName: 'playtesting-api-key',
            description: 'playtesting-api-key',
            enabled: true,
        });

        //I need to create a usage plan that associates this API key with my api
        const usagePlan = new apigateway.UsagePlan(this, 'playtesting-api-usage-plan', {
            name: 'playtesting-api-usage-plan',
            description: 'playtesting-api-usage-plan',
            apiStages: [{
                api: api,
                stage: stage,
            }],
            throttle: {
                burstLimit: 1000,
                rateLimit: 1000,
            },
            quota: {
                limit: 1000,
                period: apigateway.Period.DAY,
            },
        });

        //I need to associate the usage plan with the api now
        usagePlan.addApiKey(apiKey);

        //I need to output the apikey as an output that I can share
        new CfnOutput(this, 'Playtesting-Api-Key', {
            value: apiKey.keyId,
        });

        // API
        NagSuppressions.addResourceSuppressions(api, [
            {
                id: 'AwsSolutions-APIG4',
                reason: 'CORS Preflight Resource, does not require authorizer',
            },
            {
                id: 'AwsSolutions-COG4',
                reason: 'CORS Preflight Resource, does not require authorizer'
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'API Gateway REST API is using the Amazon Managed Policy: service-role/AmazonAPIGatewayPushToCloudWatchLogs.',
            },
            {
                id: 'AwsSolutions-APIG2',
                reason: 'API Gateway REST API methods.',
            }
        ], true);





        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/register/OPTIONS/Resource", [
            {id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition."},
            {id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition."}
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/register/POST/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/validate/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/validate/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtester/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtester/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtester/POST/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/aisummary/POST/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/aisummary/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/GetS3Buckets/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/GetS3Buckets/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/GetS3BucketObjects/POST/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/GetS3BucketObjects/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestsession/POST/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestsession/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestsession/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestsessionobservations/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestsessionobservations/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestListGLApplications/GET/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "The API method requires an API key but does not require authorization. This is expected for this use case." },
            { id: 'AwsSolutions-COG4', reason: "The API method does not require Cognito user pool authorization for this use case." }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtesting-api/Default/playtestListGLApplications/OPTIONS/Resource", [
            { id: 'AwsSolutions-APIG4', reason: "CORS Options shouldn't have an authorizer per definition." },
            { id: 'AwsSolutions-COG4', reason: "CORS Options shouldn't have an authorizer per definition." }
        ])


        // stage
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/prod/Resource", [
            {id: 'AwsSolutions-APIG6', reason: 'NAG seems to not detect the enabled logging on stage level correctly.'}
        ])

        // Lambdas
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PTGLStreamLambda/ServiceRole/Resource", [
            {id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.'},
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PTGLStreamLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to start stream sessions of all available stream group - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlaytesterRegister/ServiceRole/Resource", [
            {id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.'},
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlaytesterValidate/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/Playtesters/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlaytestGenerateSummary/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])

        //need to create a nagsuppression for adding the new iam policy allowing wildcard resource access to ssm
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlaytesterRegister/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])

        //I need to create a nagsuppression for adding the new iam policy allowing wildcard resource access for PlaytestGenerateSummary lambda
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlaytestGenerateSummary/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        //I need to create a nagsuppression for adding the new iam policy allowing wildcard resource access for GetBucketsLambda lambda
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/GetBucketsLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/GetBucketsLambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])

        //I need to create a nagsuppression for adding the new iam policy allowing wildcard resource access for GetBucketObjectsLambda lambda
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/GetBucketObjectsLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/GetBucketObjectsLambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlayTestSessionsLambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlayTestSessionsLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtestSessionObsLambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/playtestSessionObsLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlayTestGLSListApplicationsLambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/PlayTestGLSListApplicationsLambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'This lambda has a wildcard permission to get parameters from ssm - this is intended behaviour and the permission is not destructive, additive or manipulating an AWS resource.'
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/gamelift-streams-get-stream-session-lambda/ServiceRole/DefaultPolicy/Resource", [
            {
                id: "AwsSolutions-IAM5",
                reason: "getStreamSessionLambda uses IAM RolePolicy that contains wildcard, but hardened to account level least priviledge."
            }
        ])
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingApiStack/gamelift-streams-get-stream-session-lambda/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Using AWSLambdaBasicExecutionRole is fine.' },
        ])


        return stage;
    }

    private createWebACL(stage: apigateway.Stage) {
        const acl = new wafv2.CfnWebACL(this, 'waf-web-acl', {
            defaultAction: { allow: {} },
            scope: 'REGIONAL',
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: 'MetricForWebACLCDK',
                sampledRequestsEnabled: true,
            },
            name: 'playtesting-api-waf',
            rules: [
                {
                    name: 'CRSRule',
                    priority: 0,
                    statement: {
                        managedRuleGroupStatement: {
                            name: 'AWSManagedRulesCommonRuleSet',
                            vendorName: 'AWS'
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'MetricForGameCastAPI-CRS',
                        sampledRequestsEnabled: true,
                    },
                    overrideAction: { none: {} },
                },
                {
                    name: 'IpReputation',
                    priority: 1,
                    statement: {
                        managedRuleGroupStatement: {
                            name: 'AWSManagedRulesAmazonIpReputationList',
                            vendorName: 'AWS'
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'MetricForGameCastAPI-IpReputation',
                        sampledRequestsEnabled: true,
                    },
                    overrideAction: { none: {} },
                },
                {
                    name: 'throttle-extensive-users',
                    priority: 2,
                    statement: {
                        rateBasedStatement: {
                            aggregateKeyType: "IP",
                            limit: 100,
                            evaluationWindowSec: 60,
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        sampledRequestsEnabled: true,
                        metricName: 'MetricForGameCastCF-ThrottleExtensiveUsers',
                    },
                    action: { block: {} },
                },
                {
                    name: 'SQLiRuleSet',
                    priority: 3,
                    statement: {
                        managedRuleGroupStatement: {
                            name: 'AWSManagedRulesSQLiRuleSet',
                            vendorName: 'AWS'
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'MetricForGameCastAPI-SQLi',
                        sampledRequestsEnabled: true,
                    },
                    overrideAction: { none: {} },
                },
                {
                    name: 'KnownBadInputs',
                    priority: 4,
                    statement: {
                        managedRuleGroupStatement: {
                            name: 'AWSManagedRulesKnownBadInputsRuleSet',
                            vendorName: 'AWS'
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'MetricForGameCastAPI-KnownBadInputs',
                        sampledRequestsEnabled: true,
                    },
                    overrideAction: { none: {} },
                },
                {
                    name: 'GeographicRestrictions',
                    priority: 5,
                    statement: {
                        geoMatchStatement: {
                            countryCodes: ['US', 'CA']
                        }
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'MetricForGameCastAPI-GeoRestriction',
                        sampledRequestsEnabled: true,
                    },
                    action: { count: {} },
                }
            ]
        });
        acl.addDeletionOverride(cdk.RemovalPolicy.DESTROY)
        // attach the ACL to a given stage
        const cfnWebACLAssociation = new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
            resourceArn: stage.stageArn,
            webAclArn: acl.attrArn,
        });
    }
}
