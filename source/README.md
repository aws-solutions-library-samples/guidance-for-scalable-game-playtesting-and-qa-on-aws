© 2025 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.

This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

# Welcome to the Amazon Playtesting Solution guidance

This solution deploys a Single Page Application (SPA) built with [ReactJS](https://react.dev/), an API built with [Amazon API Gateway](https://aws.amazon.com/api-gateway/), [AWS Lambda](https://aws.amazon.com/lambda/), [AWS Step Functions](https://aws.amazon.com/step-functions/), and [Amazon Cognito](https://aws.amazon.com/cognito/) for authorization and authentication to host Amazon GameLift stream sessions behind a login page. It further uses an [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) table for meta information around playtesting sessions as well as registered play testers. 
  
## How to Deploy the solution guidance

This CDK stacks deploy both a frontend and a backend for the solution guidance.  Adding and removing most GameLift Streams resources can be handled directly within the frontend application.

![](architecture/playtesting-solution-architecture.png)

The Application is deployed through 2 cdk stacks:

1. **BackendStack:** Deploys the serverless API to a region of your choice. This includes 
   1. All needed Lambda functions as well as step functions
   2. Amazon API Gateway 
   3. AWS WAF to secure the API
   4. Amazon DynamoDB Table for meta information
   5. Amazon Cognito for authorization and authentication
1. **FrontendStack:** Deploys a single page application (SPA) to `us-east-1`. This deployment includes:
   1. Amazon S3 bucket containing the playtesting frontend SPA
   2. Amazon CloudFront CDN distribution distributing the SPA
   3. AWS WAF to secure the CloudFront distribution

### Deployment

1. Download the latest gamelift streams aware `aws-sdk` from the Amazon GameLift Streams Console.
2. Unzip and copy the `aws-sdk` folder to the folder `dependencies` in this project.
3. Run `npm install npm-run-all --save-dev` and run `npm run install-all` in the root of this project to install dependencies in all subprojects and lambdas. [CDK Bootstrap if you have not previously deployed infrastructure using cdk into your AWS account.](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html).
4. Run `npm run deploy-all --user=ADMIN_USERNAME --password=ADMIN_PASSWORD --email=USER@example.com --PTuser=PLAYTESTER_USERNAME --PTpassword=PLAYTESTER_PASSWORD --PTemail=PLAYTESTER@example.com` to deploy the entire solution.
5. Use the URL in the output options when deployment is complete to access the admin portal.  You will also need this URL for the discord bot along with ApiKey that you'll need to get from API Gateway.  Install time should take 15-20 minutes.

### Bot Setup instructions

TODO:

## Exploring the solution installation

You should have two CDK stacks installed.  The first within us-east-1 and second in us-east-2 (both by default).  The backendstack should install:  DynamoDB, Statemachine (step functions), parameter store values, APIGW, WAF, Cognito users/applicaton/pool, and Lambdas.  The frontendstack should deploy the single page application (SPA) to S3 along with cloudfront.

## Frontend Development

Once the API stack is deployed and you have update the Amplify config values in `App.tsx`, you can use `npm start` in the `frontend` to run the frontend locally with the API in the cloud to accelerate your frontend development without the need of redeployment for every code change.

## NOTES

1.  Out of the box the solution is installed to both us-east-1 (frontendstack) and us-east-2 (backendstack)
2.  If using GenAI Summarization option you will need to grant the account region (and cross reference region) access to the model being used with Amazon Bedrock.  Currently, be default we are using Claude 3 Haiku.  If you wish to change this, please be sure to change the model within the GenAISummary lambda as well.
3.  When supplying passwords during install process make sure they fit the cognito requirements or confirmation of those accounts will fail.
