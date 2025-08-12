#!/usr/bin/env node

/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PlaytestingApiStack } from '../cdk/BackendStack';
import { PlaytestingFrontendStack } from "../cdk/FrontendStack";
import { Playtesting } from '../cdk/Playtesting';
import { AwsSolutionsChecks } from 'cdk-nag'


const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

// deployed to current region of choice
const playtest = new Playtesting(app, 'PlaytestSolution', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    description : "Guidance for Scalable Game Playtesting and QA on AWS (SO9607)"
});

//// deployed to current region of choice
//const api = new PlaytestingApiStack(app, 'PlaytestingApiStack', {
//  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
//});

// ensure the frontend is deployed to us-east-1 to have the WAF in the right place for CloudFront
const frontend = new PlaytestingFrontendStack(app, 'PlaytestingFrontendStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});


//frontend.addDependency(api)