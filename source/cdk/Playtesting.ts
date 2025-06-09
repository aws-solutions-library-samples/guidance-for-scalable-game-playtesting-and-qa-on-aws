import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PlaytestingApiStack } from '../cdk/BackendStack';


export class Playtesting extends cdk.Stack {

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // deployed to current region of choice
        const api = new PlaytestingApiStack(scope, 'PlaytestingApiStack', {
            env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
        });

        // Ensure that the replacement happens **after** CDK resolves the value
        this.node.addDependency(api); // Ensures `api` deploys first

    }

}