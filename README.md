# Guidance for Scalable Game Playtesting and QA on AWS

1. [Overview](#overview)
    - [Cost](#cost)
2. [Prerequisites](#prerequisites)
    - [Operating System](#operating-system)
    - [Supported Regions](#supported-regions)
3. [Deployment Steps](#deployment-steps)
    - [Deploying Discord Bot](#deploying-discord-bot)
4. [Enabling Sentiment Analysis](#enabling-sentiment-analysis)
5. [Enabling Forensic Watermarking](#enabling-forensic-watermarking)
6. [Deployment Validation](#deployment-validation)
7. [Running the Guidance](#running-the-guidance)
    - [Admin](#admin)
        - [Logging In](#logging-in)
        - [Home Page and Dashboard](#home-page-and-dashboard)
        - [Managing your playtests](#managing-your-playtests)
        - [Sentiment Analysis and Summarizations](#sentiment-analysis-and-summarizations)
        - [Watermark Analyzer](#watermark-analyzer)
    - [Playtesters](#playtesters)
        - [Playtester Logging In](#playtester-logging-in)
        - [Playtesting](#playtesting)
    - [Running the Bot](#running-the-bot)
8. [Next Steps](#next-steps)
9. [Cleanup](#cleanup)


## Overview

This guidance helps customers by providing a starter kit for their playtesting needs. Today, customers face many challenges with playtesting. One of those challenges is not having an easy way for playtesters to signup for playtesting. Another challenge is coordinating client-side builds across many unique PC setups around the world. Furthermore, the concern around sharing pre-launch gaming builds can become quite a scary experience for new startups, as they have to find ways to best secure their IP. With this guidance, customers can leverage a full solution made up of three parts: 1. React front end that enables customers to serve their player base with a streamed playtesting experience as well as a full administrative portal for studios and publishers; 2. Full backend infrastructure enabling the frontend via APIs, secured with [AWS WAF](https://aws.amazon.com/waf/) as well as [Amazon Cognito](https://aws.amazon.com/cognito/) for authorization; 3. A starter Discord bot setup that allows playtesters to never leave Discord to "Opt-In" and register for playtest sessions.

To further protect pre-launch builds, playtest sessions can optionally use **forensic watermarking**. A near-invisible pattern, unique to each playtester's stream, is added to the game's video on the streaming host. If footage of the playtest leaks (for example a recording posted to YouTube in violation of an NDA), the studio can take a screenshot of it and use the built-in Watermark Analyzer to identify which playtester and which playtest session it came from. See [Enabling Forensic Watermarking](#enabling-forensic-watermarking).

![](source/architecture/playtesting-solution-architecture.png)


### Definitions

- Playtester: A user who will be playtesting a game session via web frontend.  This user will be given an URL that will launch them into a web frontend in which they start the game session and play the game.  During playtesting, users are expected to record their observations via the test panel provided.
- Playtest Session:  A game session that is created by a studio to be active during a given time frame.  These sessions can be partial game builds or full game builds that studios upload during the playtest session creation process.  a playtest session can have multiple playtesters that will connect to the game session all using Amazon GameLift Streams.
- Observation: Created during the playtest session process.  Observations are questions posed by a studio/publisher that require playtester's to respond to during a playtest session.  For example, a studio may create a playtest session with these observations.  *What do you think about the combat style?* or *How does the layout feel with this current level design?*  Playtesters respond to each question during a playtesting session.


### Cost

_You are responsible for the cost of the AWS services used while running this Guidance. As of July 2025, the cost for running this Guidance with the default settings in the US East (N. Virginia and Ohio for GameLift Streams) is approximately $11,964 per month for servicing (100 players playing 8 hours per day for a week straight)._

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
| Amazon Bedrock | Claude Haiku 4.5, 1 avg request per minute for 8 hours per day.  100 average input tokens with 500 average output tokens | $ 9.36 |
| Amazon GameLift Streams | 100 players streaming 8 hours per day, for 7 days, using Windows Gen5 stream class at $2.13 per hour | $ 11,928.00 |
| Forensic watermarking (optional) | Watermark rendering adds no GameLift Streams cost. DynamoDB seed records (one small item per stream start), AWS Lambda analysis at roughly $0.01 per screenshot analyzed, and S3 storage for saved evidence screenshots | < $ 1.00 |

## Prerequisites

### Operating System

These deployment instructions work on both Windows and Mac-based operating systems. Below are the required installations before deploying:

- Install [Node.js](https://nodejs.org/en/download/) (v22 or above).  (Optional: install Node.js and npm with the [Node Version Manager](https://github.com/nvm-sh/nvm).
- Install [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Use the [AWS Cloud Development Kit](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) (AWS CDK).  You can use aws configure via AWS CLI or other mechanisms to authenticate your terminal to use CDK
- Make sure you have installed [AWS Command Line Interface](https://docs.aws.amazon.com/cli/v1/userguide/cli-chap-install.html) (AWS CLI)
- Make sure you have your [AWS Profile](https://docs.aws.amazon.com/cli/v1/userguide/cli-chap-configure.html) set up to point to the correct account and the us-east-2 region
- (Optional, only if you plan to use forensic watermarking) Install [Docker](https://docs.docker.com/get-docker/) or [Finch](https://github.com/runfinch/finch). The watermark host components are compiled inside containers, so no other build tools are needed



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

 ```git clone https://github.com/aws-solutions-library-samples/guidance-for-scalable-game-playtesting-and-qa-on-aws.git```

2. Change directory to the repo folder:

 ```cd <repo-name>/source```

3. Install dependencies in all subprojects and Lambda functions:

 ```npm run install-all```

4. (skip if already have bootstrapped account).  Perform [CDK Bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) if you have not previously deployed infrastructure using AWS CDK in your AWS account
Supported Regions.  **NOTE: The default installation is within two regions (us-east-1 for the frontend and us-east-2 for the backend).  Be sure you have bootstrapped both regions**

5. Located the file *.env.example* within the source directory and remove the *.example* extensions.  Open that .env file and replace each value then save your changes (see images below): This is used to create your initial admin cognito account for using the admin portal.  You will be prompted to change your password and verify your email address after login.

![](assets/RemoveEnvExample.png)
![](assets/AdminCognitoSetup.png)

6. Run the following command to deploy the entire solution (except the Discord Bot):

 ```npm run deploy-all``` 

7. When deployment is complete, to access the admin portal use the URL in the PlaytestingFrontendStack Outputs tab within CloudFormation on the AWS Console.  Optionally, you should see the URL located in the terminal window after deployment (should see *Outputs: PlaytestingFrontendStack.CloudFrontDomain = <YOUR_CLOUDFRONT_URL>*). Install time should take 15-20 minutes.

8. After installation is complete, you will need to access your email in order to get your one-time password to login for the first time.

### Deploying Discord Bot

Refer [here](https://github.com/aws-solutions-library-samples/guidance-for-scalable-game-playtesting-and-qa-on-aws/blob/main/source/bot/README.md) to guide you through editing your Discord bot with these values, as well as deploying your Discord bot.

## Enabling Sentiment Analysis

This is an optional step.  However, if you do not enable this section of the solution you will not be able to peform player response summarizations nor sentiment analysis.  You will be enabling a model within the AWS console underneath the bedrock service.

1. Navigate to your AWS Console

2. Search for Amazon Bedrock

3. On the left side of the screen underneath the Amazon Bedrock menu sections, scroll down to the section *Configure and learn* and select Model access. NOTE: make sure you are in the proper region where your API stack was installed (Ohio by default)

![](assets/Bedrock1.png)

4. Locate the *Modify model access* button at the top of the page and click it.

![](assets/Bedrock3.png)

5. Now scroll down until you see the Anthropic section and select Claude Haiku 4.5.  Then scroll down to the bottom of the page and click the next button.  Then on the next page click the submit button.  Now you are setup to use this feature.  Look in the *Running the Guidance* section for more details on how to use this feature.

**NOTE: This solution uses Claude Haiku 4.5 via a cross-region (US) inference profile. Make sure you request model access to Claude Haiku 4.5 in the same region family (us-east-1) that the inference profile routes to.**

![](assets/Bedrock2.png)

## Enabling Forensic Watermarking

This is an optional step. Forensic watermarking lets you trace leaked footage of a playtest back to the playtester who recorded it. If you do not plan to use it, you can skip this section; playtest sessions are not watermarked unless you turn it on.

### How it works

When watermarking is enabled for a playtest session, every playtester's stream gets a near-invisible pattern added to each video frame. The pattern is drawn **on the GameLift Streams host, before the video is encoded**, so it is present in anything a playtester can capture: screen recordings, capture cards, the browser's video stream, and even a phone photo of the monitor. Your game's code is not modified, and the mark adds no frame of latency.

Each time a playtester starts a stream, the backend generates a new random 128-bit seed for the pattern. It records which playtester and playtest session the seed was issued to, and passes the seed to the streaming host. The seed is never sent to the playtester's browser. Later, the Watermark Analyzer compares a screenshot against the recorded seeds and reports which one is present.

The playtester is identified from their signed-in account, not from anything their browser sends, and each playtester can only stream a session they registered for themselves. Admins can stream any session for testing; an admin's stream is recorded under the admin's username and flagged as an admin stream.

### Supported runtimes

| Runtime | Supported | How the mark is added |
|---|---|---|
| Proton (8.0-5, 9) | Yes | A Vulkan layer that ships inside your game package |
| Microsoft Windows Server 2022 Base | Yes (Direct3D 11 and Direct3D 12 games) | A proxy `dxgi.dll` that ships next to your game's executable |
| Ubuntu 22.04 LTS | No | Not supported; the watermark toggle is disabled for this runtime |

**NOTE: Proton 8.0-2c has not been validated. Games that render with Vulkan on the Windows runtime are not currently supported.**

### Step 1: Build the watermark host components

The host components are built from source inside containers, so you need [Docker](https://docs.docker.com/get-docker/) or [Finch](https://github.com/runfinch/finch) running and network access; no compilers are needed on your machine. No prebuilt binaries are included. From the `source` directory, run:

```npm run build-watermark```

This builds both runtimes. To build only one, add `-- --runtime proton` or `-- --runtime windows`. To use Finch instead of Docker, set the environment variable `CONTAINER_CLI=finch` first.

The output is written to `source/watermark/build/` (`proton/` and `windows/`). The first Windows build takes around five minutes because it builds an image containing the two HLSL shader compilers; later builds take under a minute.

### Step 2: Add the components to your game package

Watermarking only works if the host components are part of the game's GameLift Streams application package. Add them to the S3 folder that holds your game **before** you create the playtest session that uses it:

For a Proton game:

```npm run stage-watermark -- --game s3://<your-bucket>/<your-game-folder>/ --runtime proton```

For a Windows game, also pass the executable's path inside the game folder (or its full `s3://` path):

```npm run stage-watermark -- --game s3://<your-bucket>/<your-game-folder>/ --runtime windows --exe Binaries/Win64/MyGame.exe```

- For **Proton**, this adds a `wmlayer/` folder and an `xdg/` folder to your game folder.
- For **Windows**, this adds `dxgi.dll` next to the executable you pass with `--exe` (Windows only searches the executable's folder for it). The script checks the executable exists first.

Nothing else in your game folder is changed. The script uses your normal AWS CLI credentials, and it won't overwrite existing watermark files unless you add `--force` (for example after rebuilding them).

**NOTE: GameLift Streams applications cannot be changed after they are created. A game that was added before its folder contained the watermark components cannot be watermarked; choose *Add New Game* again after staging the components. When you enable watermarking, the solution checks the game package and stops you with an error if the components are missing, so a session can never silently run without a mark.**

### Before you use watermarking

- **Anti-cheat:** anti-cheat systems commonly block proxy DLLs and graphics hooks. Build your playtest with anti-cheat disabled, or check with your anti-cheat vendor about allowlisting.
- **Permission:** if you are streaming a title you do not own outright, confirm the publisher agreement allows additional files in the build's package.
- **Tune for your content:** the default mark strength and detection threshold were measured on a small set of titles. Test with your own game. At the default strength, the pattern can be faintly visible on large flat areas of the screen.
- **What it does not cover:** the watermark survives cropping, rescaling, mirroring, 90-degree rotation and heavy JPEG compression. It does not survive arbitrary-angle rotation, and a determined attacker with signal-processing tools may be able to weaken it. Treat it as a strong deterrent and investigation tool, not a guarantee.
- **The watermark host components are a proof of concept** and are provided without support.

See [Managing your playtests](#managing-your-playtests) to turn watermarking on for a session, and [Watermark Analyzer](#watermark-analyzer) to investigate a leak.

## Deployment Validation

* Open the CloudFormation console and verify the status of the templates PlaytestingFrontendStack in us-east-1 (N. Virgina) and PlaytestingApiStack in us-east-2 (Ohio).

* Open the CloudFormation console (make sure you are viewing the region with your frontend stack, which should be us-east-1 by default) and click on the Outputs Tab of the PlaytestingFrontendStack.

* Navigate to the CloudFrontDomain URL listed from step 7 above. Use your admin credentials that were sent to your email address. If successful, you should see the home page.



## Running the Guidance

In this guidance, we will walk through the functions of the admin page as well as the playtesting page that playtesters will see. **NOTE: This solution does not ship with a testable game.**

### Admin

The Admin's portal is used to create and manage playtest sessions.  Furthermore, studios can get a sentiment/summerization of playtesters feedback per playtest session.  In the sections below we'll explore how to login, understanding the various pages, creating your first playtest session, further managing those playtest sessions, and interacting with the generative sentiment analysis of players feedback.

#### Logging In

After navigating to the newly created CloudFrontURL from installation process you will see a login box.  You'll need to navigate to your email account and look for your temporary password (check your junkmail if you don't receive an email after 5-10 minutes).  After logging in, you will be required to change your password.

![](assets/ChangePassword.png)

#### Home Page and Dashboard

After successfully logging in you will be routed to the home page/Dashboard.  On this screen you will see all created playtests sessions.  You will also be able to see any playtesters by selecting a playtest session.  On the left side of the screen you will see two links:  Dashboard and Manage playtest sessions.  On the right side of the screen you will see and "!" Icon that allows you to expand out the summarization/sentiment analysis ability for playtest sessions.  We will walk through all these functions further down.

#### Definitions

- Playtest Name: This is the name you give a playtest session
- Game: The name of the game (or build) that is being playtested
- Studio: The studio that created the game
- Start Date: The date that you wish the playtest session to be available.
- End Date:  The date tht you wish the playtest session to end (this is an inclusive date).
- Enabled: Is this playtest session currently enabled?
- Forensic Watermarking: Does this playtest session add a per-playtester forensic watermark to every stream? (see [Enabling Forensic Watermarking](#enabling-forensic-watermarking))
- Status: A playtest session could be in various status (Active, Error, Intializing)


![](assets/Dashboard1.png)

Summarization/Sentiment Feature located by the signout button.  We will cover this feature further on down.  See image below

![](assets/Dashboard_Summarize.png)

Let's go ahead and navigate to managing your playtests by clicking the Manage Play Sessions on the left side of the screen.  Now head into the *Managing your playtests* sections to setup your first playtest!

#### Managing your playtests

In this section we will walk you through setting up your first playtest session.  We will also point out the various features located in this area which are (Creating, Updating, and Deleting playtest sessions).  Let's start off with creating your first playtest session.  To do so, click the *Create New* button as you see below with the red arrow.

![](assets/Manage_CreateNew1.png)

You should now see a wizard that will walk you through each of the 6 steps to submit your new playtest for creation.  On this first step, you will need to provide a few details.  Playtest Name (this is the name you give a playtest session), Game (The name of the game or build that is being playtested), and Studio (The studio that created the game).  Lastly, you should see an enabled checkbox that should be checked by default.  However, if you do not want this playtest session to be available for registration yet; feel free to disable it for now.  When all fields are filled out please click the Next button.

![](assets/Manage_CreateNew2.png)

Game details section is where you specify the game that you wish to be playtested during this session.  This can be partial or full build, it doesn't matter as long as it's an executable.  You will see two radio buttons, the first *Add New Game* allows you to add your executable as a application (game) behind the scenes to GameLift streams.  When selecting *Add New Game* you will need to browse your S3 buckets and find:  

- the S3 Bucket path to the application/game folder (this should contain the executable as well as any other assets, libraries, etc).
- the S3 Bucket path to the executable itself (you should be selecting your .exe at this point).

Then you need to choose your runtime environment in order to run your game.  For example, if your game runs specifically on windows; then choose *Microsoft Windows Server 2022 Base*.  Now, if you already have previously added a new game either by creating a previous playtest session with a game added then; or if you had previously went to the AWS console within GameLift Streams and directly added it there.  Then you can choose the *Select Existing Game* option.  After either adding a new game or selecting a previously added on you may click the Next button to proceed.

**NOTES: As mention earlier, this process creates an application within GameLift Streams Console within your AWS account.  Also, If you plan to use a non windows based stream group be sure that you do not select a game that is windows base or you will have errors.**

![](assets/Manage_CreateNew3_AddNewGame.png)  ![](assets/Manage_CreateNew3_ExistingGame.png)

On step 3 you are setting up your streaming details.  This includes creating a short description for the streaming group you are creating.  For example, perhaps you are wanting to test how well your build works on a Gen4 GPU; so you would add those details to the description.  Then you would select the streaming class from the drop down menu.  Lastly, you select which regions you wish to deploy your playtest session to.  Within each region you will also define how much capacity you need (as well as type Always-on or On-Demand).  You must select at least one region.  When your selections have been made navigate to the next section

**NOTES:  Make sure you have the capacity available for the regions you are selecting or you will get an error creating the playtest session.  Check with your account team if you are unsure about region capacity for GameLift Stream groups**

![](assets/Manage_CreateNew4.png)

Also on this step you can turn on *Forensic watermarking* for the playtest session. When it's on, every playtester's stream carries a near-invisible watermark that identifies them, which you can later check with the [Watermark Analyzer](#watermark-analyzer). The toggle is only available for Proton and Windows runtimes, and your game's package must already contain the watermark components (see [Enabling Forensic Watermarking](#enabling-forensic-watermarking)). *Advanced watermark settings* lets you change the mark's strength (1 to 64, default 8); leave it at the default unless testing shows you need a stronger or fainter mark. When you create the playtest, the solution checks the game package; if the watermark components are missing, the playtest isn't created and the error lists exactly which files to add. You can also turn watermarking on or off later when updating a playtest session. The change applies to streams started after you save it.

Step 4 we are selecting the start date, start time, and end date of the playtest session.  If playtesters try to playtest outside of this range they will not be able to.  After setting your playtest date range navigate to the next step.

**NOTE:  Currently if a playtester is playing a session while a session has expired or was marked disabled, the playtester will still be able to play.  Only when the playtester refreshes the screen will the changes be seen**

![](assets/Manage_CreateNew5.png)

In step 5 we are creating questions for playtesters.  These are observations you would like playtesters to make when playing this session.  Currently, these are in free form text allow you to provide as much detail as possible to define what you would like your playtesters to examine during this session.  When you are satisfied with your questions for the playtest session navigate to the last step to submit and create.

![](assets/Manage_CreateNew6.png)

The final step of the process just reminds you to review your steps before creating the playtest session.  You can navigate to any step by clicking on the step you wish to navigate to on the left side of the wizard.  When you are ready click the *Create Playtest* button.  You should see a modal popup confirming the creation process and after confirming you will be brought back to the Dashboard screen in which your playtest solution will start the creation process.

![](assets/Manage_CreateNew7.png)

Back on the dashboard screen you should see a new playtest session on the dashboard with a status of *Initializing* Behind the scenes there is a Step Function process that is orchestrating the creation of a new GameLift Streams Application (or using an existing one) and GameLift Streams stream group.  This can take some time to finish initializing depending upon how many regions as well as capacity needed for each region

![](assets/Dashboard2_Initializing.png)

Below is a screenshot of the Step Function in action waiting to finish up.

![](assets/StepFunction3_Initializing.png)

In some cases errors can happen.  For example, as noted above, if you try to set a capacity beyond what you have available within a particular region you will receive an error like below.

![](assets/Dashboard2_Error.png)

Best way to approach trouble shooting an error would be to work backwards from the step function and see which step the creation process failed at.  From there, you can investigate the API call that was made and ultimately review the CloudWatch logs of the associated Lambda function to see what caused the error.  In this particular case, I had exceed the capacity limit for a certain region I had selected after reviewing the CloudWatch logs.

![](assets/StepFunction3.png)

The best course of action if you get an error is to find out what caused the root error and then delete the playtest session and recreate again.  I'll show you later on how to delete a playtest session.  After creating a successful playtest session you should see an *Active* status indicating that your playtest session is ready to accept playtesters.

![](assets/Dashboard2_Active.png)

Now lets navigate back to managing your platest sessions and let's make some adjustments to the newly created playtest sessions.  This time when you head back to managing playtest sessions you will see a new record that shows up.  Please select that playtest session in order to make any updates.

![](assets/Manage_Updating.png)

Note above all the fields that are editable.  Any changes made above will only take affect after clicking the *Update Playtest Session* button.  The screen will not refresh nor will you be navigated to a different page; but instead at the top you should see a green status message indicating that the update was made.  Make any updates you wish then navigate back to the Dashboard page to see them on the dashboard screen.

Let's say that this playtest is finished and you do not wish to keep it any longer.  Navigate back to manging your playtest sessions and select the playtest session you wish to delete.  After clicking delete you will be asked for confirmation before your deletion is made.

**NOTE: You don't have to delete playtest sessions, but if you do no playtester's response will be deleted they will still be present within the playtesters table within DynamoDB.  Currently, you will not be able to see nor use the summarize feature of playtester responses after deleting their corresponding playtest session**

![](assets/Manage_Deleting.png)

Now that we have explored how to manage our playtest sessions let's explore how we can see the playtesters and their responses.  We will also go through and summarize some of their responses using the GenAI feature of this solution.

### Sentiment Analysis and Summarizations

Navigate back to the dashboard page and select a playtest session.  Please select a playtest session that has playtesters that have recorded observations.  After selecting you should see the list of playtesters along with their recorded observations.

![](assets/Dashboard3_PlaytesterResults.png)

Now as long as a playtest session is selected and you have some recorded observations you can click the *I* icon on the top right of the screen to expand out the GenAI summarization feature.  From here you can ask the model questions about the playtest session such as "What do the players think about the current playtest session?"  or "What areas should we focus our next development efforts around based upon players responses?"

![](assets/Dashboard_Summarize_Example.png)

If you try to engage with the model without any data you will get a "Wild error" and we don't want that!

![](assets/SummarizeError.png)

### Watermark Analyzer

The Watermark Analyzer identifies which playtester and playtest session a piece of leaked footage came from. For example: a studio runs a weekend playtest with forensic watermarking turned on, and on Monday a recording of the build shows up on YouTube. The studio takes a screenshot of the video and runs it through the analyzer to find out who recorded it.

1. Click *Watermark Analyzer* on the left side of the screen.

2. Select the playtest session you believe the footage came from. The list shows every session that has had at least one watermarked stream, including sessions you have since deleted. If you are not sure, choose *All sessions*. Narrowing to one session is faster and gives the most reliable result.

3. Upload a screenshot of the footage (PNG, JPEG or WebP). For the best results:
    - Use the highest-quality frame you can get: pause the video at full screen at its highest resolution rather than capturing a thumbnail.
    - Pick a frame with plenty of detail on screen; very dark or blurry frames carry less of the mark.
    - Crop out the video player and anything around the game if you can. Black letterbox bars are trimmed automatically.
    - The screenshot must be at least 256 x 256 pixels.

4. Click *Analyze*. The analyzer first checks whether the image is at its original scale, which takes a few seconds. If it isn't (common for screenshots and photos of a screen), it also searches a range of scales, which can take up to about 20 seconds.

5. Review the result:
    - **Watermark identified:** shows the playtester (their Discord username), the playtest session and game, when and where they started the stream, and a detection score. A score above the threshold of 8 is a match; a genuine match typically scores far higher (often 100 or more on a clean capture), while unrelated playtesters score around 5. The gap between the top result and the runner-up is also shown; a large gap means a clear identification.
    - **No watermark found:** no recorded seed scored above the threshold. Common reasons: the session was not watermarked, the wrong playtest session was selected, the image was rotated at an angle, or the image is too small, blurry or heavily processed. Try *All sessions*, or a different, sharper frame.

A *Details* panel lists the closest candidates and how the image was processed, which helps when a result is borderline.

![](assets/WatermarkAnalyzer1.png)

#### Managing evidence

Every analysis is saved as an evidence record: the screenshot you uploaded, the result, which admin ran it, when, and a SHA-256 fingerprint of the file so you can show it hasn't been altered. Saved records appear in the *Evidence* list on the Watermark Analyzer page, where you can open one to review the screenshot and result again. Evidence is kept until you delete it, so once an investigation is settled, select the records and click *Delete*. This permanently removes the screenshots and results.

![](assets/WatermarkAnalyzer2.png)

**NOTES: The Watermark Analyzer and its evidence are only available to admins. Evidence records name the identified playtester, so treat them as personal data under your studio's data-handling policies. Watermark records are kept when you delete a playtest session, so you can still investigate a leak after a session has ended.**

### Playtesters

The playtesters portal is used by playtesters to participate in a playtest session.  Playtesters will be able to select which region they wish to stream from (default is the lowest latency), start a stream for playtesting, and record observations.  Playtesters can return back to the same session (as long as it's still enabled and within date range) at anytime to further evaluate and record observations.

**NOTE: If a playtest session ony has a single region you will not be able to select other regions**

**NOTE: A playtest link only works for the playtester who registered for it. Someone signed in with a different account who opens another playtester's link can't start a stream; they need to register for the session through the Discord bot to get their own link.**

![](assets/Playtesting1.png)

#### Playtester Logging In

After receving the URL from the Discord bot you will be prompted to enter your temporary password along with your username.  You'll need to navigate to your email account and look for your temporary password (check your junkmail if you don't receive an email after 5-10 minutes).  After logging in, you will be required to change your password.

![](assets/ChangePassword.png)

#### Playtesting

When you have successfully logged in you will see the main playtesting page.  From here, choose which region you wish to start streaming from.  You can select a new region by locating the dropdown at the top left of the screen.  Notice that by default the lowest latency region has already been selected for you.

![](assets/Playtesting9.png)

After you have selected your region let's go ahead and start the stream.  Locate the *Start Stream* button and click it.  It will turn grey as it awaits for your stream to be ready.  Some games (depending upon size) may take a few moments to intially start.

![](assets/Playtesting2.png)

Then moments later you should see your game begin to stream like the image below

![](assets/Playtesting3.png)

Now, lets look at the bottom of the page where the testing outcomes are located.  Look at the bottom right of the screen you should see an up arrow.  Click that to expand upwards the testing outcomes that the studio wishes for you to observe and record your observations.  Notice though, as you're streaming you will not be able to type in here until you've disabled the input.  Once you've disabled the input you can start recording your observations.  We have to disable the input otherwise the browser will still be trying to send keyboard commands to your game session.

**NOTE: However way you decided to record your observations don't forget to find the *Submit Observations* button located below all the testing outcomes.**

![](assets/Playtesting4.png)

Use the options drop down to disable the input in order to edit the Testing outcome fields

![](assets/Playtesting7.png)

You may also notice the cog that is located now midway on the screen on the left-hand side from when the testing outcomes had expanded upwards.  If you click on this you will be given an option to move your testing outcomes to the left side of the screen instead of the bottom.  You can change this at anytime.

![](assets/Playtesting5.png)

View of what the testing outcomes look like on the right side of the screen

![](assets/Playtesting6.png)

Now, you can choose to keep the default playtesting view of your stream.  Or, if you prefer to play fullscreen then locate the fullscreen icon in the upper right section of the stream screen.  Clicking that will put you into fullscreen mode.  While in fullscreen mode you may hit escape at anytime to return to the default view.

![](assets/Playtesting8.png)

Lastly, if you try playtesting a session that has been disabled or no longer valid you will receive an error message like the one below.  At anypoint you feel like there shouldn't be an error please reach out to the studio hosting the event.

![](assets/Playtesting10.png)

**NOTE: If you are still playing will a session does get disabled or expires you will be able to continue playing until you either terminate the session, close the browser, or studio forcefully shuts down the session**

#### Running the Bot

Refer [here](https://github.com/aws-solutions-library-samples/guidance-for-scalable-game-playtesting-and-qa-on-aws/blob/main/source/bot/README.md) to guide you through how to run the bot.

## Next Steps

This guidance demonstrates setting up a single playtest session and registering a playtester to that session.  You may want to test with a larger internal team with muliple session and within mulitple regions that your stream groups are deployed to.  Have playtesters experiment around with streaming from different regions.  Lastly, see what kind of sentiment gets generated after many playtesters report in their observations. 


## Cleanup

Tearing down the solution is fully automated. From the `source` directory, run:

```
npm run destroy-all
```

This deletes all stacks (`PlaytestSolution`, `PlaytestingApiStack` in us-east-2, and `PlaytestingFrontendStack` in us-east-1). The S3 buckets that host the frontend are configured to purge their contents and delete automatically as part of the teardown, so there is no need to manually empty them first.

**NOTE: This is a destructive operation. It removes the Cognito user pool (including the admin user), the DynamoDB tables (including any playtest/playtester data), the S3 buckets and their contents, and the CloudFront distribution.**

**NOTE: If you used forensic watermarking, tearing down the solution also deletes the watermark seed records and all saved evidence (screenshots and results). Without the seed records, footage from those playtests can no longer be traced. If you want to keep any of this, copy it somewhere outside the solution before running `destroy-all`; anything you copy elsewhere is not touched by the teardown. The watermark files you staged into your own game's S3 folder are also not removed; delete the `wmlayer/` and `xdg/` folders (Proton) or `dxgi.dll` (Windows) yourself if you no longer need them.**

Redeploying after a teardown is painless: just run `npm run deploy-all` again. The deployment writes the new stack values into a generated config file (`frontend/src/aws-config.generated.json`), so there is nothing to manually reset between a destroy and a fresh deploy.
