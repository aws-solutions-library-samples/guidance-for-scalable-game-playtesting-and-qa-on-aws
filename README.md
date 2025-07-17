# Guidance for Scalable Game Playtesting and QA on AWS

1. [Overview](#overview)
    - [Cost](#cost)
2. [Prerequisites](#prerequisites)
    - [Operating System](#operating-system)
    - [Supported Regions](#supported-regions)
3. [Deployment Steps](#deployment-steps)
    - [Deploying Discord Bot](#deploying-discord-bot)
4. [Deployment Validation](#deployment-validation)
5. [Running the Guidance](#running-the-guidance)
    - [Admin and Playtester Login](#login-admin-and-playtesters)
    - [Admin Functions](#admin-functions)
6. [Next Steps](#next-steps)
7. [Cleanup](#cleanup)


## Overview

This guidance helps customers by providing a starter kit for their playtesting needs. Today, customers face many challenges with playtesting. One of those challenges is not having an easy way for playtesters to signup for playtesting. Another challenge is coordinating client-side builds across many unique PC setups around the world. Furthermore, the concern around sharing pre-launch gaming builds can become quite a scary experience for new startups, as they have to find ways to best secure their IP. With this guidance, customers can leverage a full solution made up of three parts: 1. React front end that enables customers to serve their player base with a streamed playtesting experience as well as a full administrative portal for studios and publishers; 2. Full backend infrastructure enabling the front end via APIs, secured with [AWS WAF](https://aws.amazon.com/waf/) as well as [Amazon Cognito](https://aws.amazon.com/cognito/) for authorization; 3. A starter Discord bot setup that allows playtesters to never leave Discord to "Opt-In" and register for playtest sessions.

![](source/architecture/playtesting-solution-architecture.png)



### Cost

_You are responsible for the cost of the AWS services used while running this Guidance. As of July 2025, the cost for running this Guidance with the default settings in the US East (N. Virginia and Ohio for GameLift Streams) is approximately $11,954 per month for servicing (100 players playing 8 hours per day for a week straight)._

_We recommend creating an [AWS Budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) through [AWS Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/) to help manage costs. Prices are subject to change. For full details, refer to the pricing webpage for each AWS service used in this Guidance._

The following table provides a sample cost breakdown for deploying this Guidance with the default parameters in the US East (N. Virginia and Ohio) Regions for one month.

| AWS service  | Dimensions | Cost [USD] per month|
| ----------- | ------------ | ------------ |
| Amazon API Gateway | 1,000,000 REST API calls per month  | $ 3.50 |
| Amazon Cognito | 2 active users per month with advanced security feature | $ 0.10 |
| Amazon CloudFront | Data transfer out to internet (.264 GB per month), Number of requests (HTTPS) (100000 per month) | $ 0.10 |
| Amazon Simple Storage Service (S3) | S3 Standard storage (.00264 GB per month) | $ 0.00 |
| AWS Lambda | Number of requests (1000000 per month) | $ 0.00 |
| Amazon DynamoDB | Table class (Standard), Average item size (all attributes) (1000 Byte), Data storage size (0.5 GB) | $ 1.63 |
| AWS Step Functions | Workflow requests (100 per month), State transitions per workflow (11) | $ 0.00 |
| AWS Web Application Firewall (WAF) | Number of Web Access Control Lists (Web ACLs) utilized (2 per month), Number of Rules added per Web ACL (5 per month) | $ 20.60 |
| Amazon GameLift Streams | 100 players streaming 8 hours per day, for 7 days, using Windows Gen5 stream class at $2.13 per hour | $ 11,928.00 |

## Prerequisites

### Operating System

These deployment instructions work on both Windows and Mac-based operating systems. Below are the required installations before deploying:

- Install [Node.js](https://nodejs.org/en/download/) (v22 or above).  (Optional: install Node.js and npm with the [Node Version Manager](https://github.com/nvm-sh/nvm).
- Install [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Use the [AWS Cloud Development Kit](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) (AWS CDK).  You can use aws configure via AWS CLI or other mechanisms to authenticate your terminal to use CDK
- Make sure you have installed [AWS Command Line Interface](https://docs.aws.amazon.com/cli/v1/userguide/cli-chap-install.html) (AWS CLI)
- Make sure you have your [AWS Profile](https://docs.aws.amazon.com/cli/v1/userguide/cli-chap-configure.html) set up to point to the correct account and the us-east-2 region
- Perform [CDK Bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) if you have not previously deployed infrastructure using AWS CDK in your AWS account
Supported Regions


### Supported Regions

While the backend stack can technically be deployed to any region, it should be deployed in a region supported by GameLift Streams. Below are the currently supported regions for GameLift Streams:

- US East (N. Virginia)
- US East (Ohio)
- US West (Oregon)
- Asia Paciﬁc (Tokyo)
- Europe (Frankfurt)
- Europe (Ireland)


## Deployment Steps

1. Clone the repo using command:

- ```git clone https://github.com/aws-solutions-library-samples/guidance-for-scalable-game-playtesting-and-qa-on-aws.git```

2. Change directory to the repo folder:

- ```cd <repo-name>/source```

3. Install dependencies in all subprojects and Lambda functions:

- ```npm run install-all```

4. Run the following command to deploy the entire solution (except the Discord Bot):

- ```npm run deploy-all --user=ADMIN_USERNAME --password=ADMIN_PASSWORD --email=USER@example.com --PTuser=PLAYTESTER_USERNAME --PTpassword=PLAYTESTER_PASSWORD --PTemail=PLAYTESTER@example.com``` 

5. Use the URL in the output options when deployment is complete to access the admin portal. You will also need this URL for the Discord bot, along with an ApiKey from AWS API Gateway. Install time should take 15-20 minutes.

### Deploying Discord Bot

1. Open the CloudFormation console (make sure you are viewing the region with your ApiStack, which should be us-east-2 by default) and click on the Outputs Tab of the PlaytestingApiStack.

2. Copy the Endpoint URL, as you'll need this for the Discord Bot.

3. Open the API Gateway console. On the left-hand side, click on API Keys.

4. Copy the playtesting-api-key API Key (there should be a copy-to-clipboard icon by the masked values). You will need this for the Discord Bot.

5. Open the admin portion of the playtesting solution and login using the admin user.

6. On the dashboard, select the playtest session you wish to set up for registering with the Discord bot and click on the "Copy Session ID to Clipboard" button. This is the final piece needed to configure your Discord bot.

7. Refer [here](https://github.com/aws-solutions-library-samples/guidance-for-scalable-game-playtesting-and-qa-on-aws/blob/main/source/bot/README.md) to guide you through editing your Discord bot with these three values, as well as deploying your Discord bot.


## Deployment Validation

* Open the CloudFormation console and verify the status of the templates PlaytestingFrontendStack in us-east-1 (N. Virgina) and PlaytestingApiStack in us-east-2 (Ohio).

* Open the CloudFormation console (make sure you are viewing the region with your frontend stack, which should be us-east-1 by default) and click on the Outputs Tab of the PlaytestingFrontendStack.

* Navigate to the CloudFrontDomain URL listed. Use your admin credentials that you specified when installing the solution to log in. If successful, you should see the home page.



## Running the Guidance

In this guidance, we will walk through the basic functions of the admin page as well as the playtesting page that playtesters will see. NOTE: We won't be setting up a playtest session in this guidance, as this solution does not ship with a testable game. 

### Login admin and playtesters

The solution guidance is shipped with Amazon Cognito, and two accounts are created during installation. The admin user should be used for administration purposes, and the playtester account is distributed to playtesters. If playtesters try to access the admin portion of the React app, they will not be allowed due to Cognito groups.
Playtesters receive their credentials upon registration and are prompted to log in when they access the unique URL generated by the Discord bot. Administrators can browse to the CloudFront-generated URL found within the output section of the PlaytestingFrontendStack, where they will be prompted to log in. The token validity for both Admin and Playtester logins is set to 1 hour with the default installation.

### Admin Functions

Home Page: The home page displays playtest sessions that have been created. You can select a playtest session to view any observation feedback submitted by playtesters. On the right-hand side of the screen, you can expand the window to generate a summarization of received feedback. On the left-hand side of the page, you will see your collapsible menu (expanded by default). Currently, there are two options: Dashboard and Manage Play Sessions.
- "What is the overall opinion of this playtest session based on playtesters' feedback?"
- "What areas should we focus on in our next development cycle based on playtesters' feedback?"

![](assets/AdminHomePage.PNG)

Manage Play Sessions: This view allows users to perform CRUD operations on playtest sessions. For new sessions, click the "Create New" button to start the creation wizard process. For existing sessions, select one to access edit options. Note that when creating new play sessions, AWS requires several minutes to spin up a new GameLift Streams stream group in your account.

![](assets/ManagePlaySessions.PNG)

Note: When creating a new playtest session, Step 2 gives you the options "Add New Game" or "Select Existing Game." If you haven't previously added an "application" to GameLift Streams or previously used "Add New Game," you will need to select "Add New Game." Your game binaries must be located in an S3 bucket beforehand. Tip: Consider having your CI/CD process deposit game builds into this S3 location to streamline this process.

![](assets/AddNewGame.PNG)

Note: On Step 3, the default stream configuration uses us-east-2 (Ohio) with an always-on capacity and on-demand capacity of 1. Each location allows you to allocate streaming capacity for available playtesters. For example, if you have a playtest session planned for next weekend and are expecting 100 players, you might want to set the "On-Demand" capacity to 100 and "Always-On" to 0, or mix and match with 50/50.

![](assets/StreamingDetails.PNG)


## Next Steps

This guidance demonstrates setting up a single playtest session with a single Discord bot. For multiple playtest sessions running simultaneously, you can deploy multiple versions of the Discord bot with different Session IDs. Additionally, while this guide demonstrates a simple playtest session setup using a single region, you may want to consider leveraging multiple regions. 


## Cleanup

- Empty the S3 buckets that host the frontend application:

    - Navigate to S3
    - Locate and empty the two buckets that begin with "playtestingfrontendstack-xxxxxxxx"

- Delete the API stack:

    - Open the CloudFormation console (ensure you are in us-east-2, the default region for the API Stack)
    - Select the PlaytestingApiStack
    - Delete the stack

- Delete the frontend stack:

    - Open the CloudFormation console (ensure you are in us-east-1, the default region for the frontend stack)
    - Select the PlaytestingFrontendStack
    - Delete the stack
