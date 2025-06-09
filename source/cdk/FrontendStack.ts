/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import * as cdk from 'aws-cdk-lib';
import {RemovalPolicy} from 'aws-cdk-lib';
import {Construct} from 'constructs';

import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import {SecurityPolicyProtocol} from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { NagSuppressions } from "cdk-nag";

export class PlaytestingFrontendStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const websiteBucket = new s3.Bucket(this, 'Playtesting-WebsiteBucket', {
            removalPolicy: RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            autoDeleteObjects: true
        });

        const loggingBucket = new s3.Bucket(this, 'Playtesting-CF-Logging-Bucket', {
            removalPolicy: RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            autoDeleteObjects: true,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER
        });

        const acl = this.createWebACL()

        const distribution = new cloudfront.Distribution(this, 'Playtesting-distribution', {
            comment: "Playtesting Distribution",
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket)
            },
            defaultRootObject: "index.html",
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
            enableLogging: true,
            logBucket: loggingBucket,
            webAclId: acl.attrArn,

            //Adding Custom Error Responses
            errorResponses: [
                {
                    httpStatus: 403, // Access Denied
                    responsePagePath: "/index.html",
                    responseHttpStatus: 200,
                    ttl: cdk.Duration.seconds(0),
                },
                {
                    httpStatus: 404, // Not Found
                    responsePagePath: "/index.html",
                    responseHttpStatus: 200,
                    ttl: cdk.Duration.seconds(0),
                },
            ]
        });

        new s3deploy.BucketDeployment(this, 'DeployWebsite', {
            sources: [s3deploy.Source.asset('./frontend/build')],
            destinationBucket: websiteBucket,
            distribution: distribution
        });


        new cdk.CfnOutput(this, "CloudFront-Domain", {
            value: distribution.domainName
        });

        // Website Bucket
        NagSuppressions.addResourceSuppressions(websiteBucket, [
            { id: 'AwsSolutions-S1', reason: 'Server access logging is not required as access to the content is only possible through CloudFront with OAI.' },
            { id: 'AwsSolutions-S10', reason: 'Enforce SSL is not required as access to the content is only possible through CloudFront with OAI.' },
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingFrontendStack/Playtesting-WebsiteBucket/Policy/Resource", [
            { id: 'AwsSolutions-S10', reason: 'Enforce SSL is not required as access to the content is only possible through CloudFront with OAI.' },
        ])

        // CF Logging Bucket
        NagSuppressions.addResourceSuppressions(loggingBucket, [
            { id: 'AwsSolutions-S1', reason: "This bucket is internal for logging purposes and server access logging is not required for it's purpose." },
            { id: 'AwsSolutions-S10', reason: 'Enforce SSL is not required for a pure internal logging bucket' },
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingFrontendStack/Playtesting-CF-Logging-Bucket/Policy/Resource", [
            { id: 'AwsSolutions-S10', reason: 'Enforce SSL is not required for a pure internal logging bucket' },
        ])

        // CF
        NagSuppressions.addResourceSuppressions(distribution, [
            { id: 'AwsSolutions-CFR1', reason: "Georestriction is an optional feature for this demo." },
            { id: 'AwsSolutions-CFR4', reason: "Minimal TLS Version is set to TLS_V1_2_2021 but its highly recommended to set up a ACM + Route53." },
        ]);

        // deployment policies
        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingFrontendStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource", [
            { id: 'AwsSolutions-IAM4', reason: 'Permissions are required to do the spa deployment to s3 using cdk' },
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingFrontendStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource", [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions is required to do the spa deployment to s3 using cdk' },
        ])

        NagSuppressions.addResourceSuppressionsByPath(this, "/PlaytestingFrontendStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource", [
            { id: 'AwsSolutions-L1', reason: 'CDK managed Lambdafunction to deploy to S3. Runetime Version is managed by CDK.' },
        ])
    }

    private createWebACL() {
        // create a basic ACL with AWSManagedRulesCommonRuleSet and AWSManagedRulesAmazonIpReputationList
        // basic rule https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html
        const acl = new wafv2.CfnWebACL(this, 'cf-waf', {
            defaultAction: {allow: {}},
            scope: 'CLOUDFRONT',
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: 'MetricForGameCastCF-ACL',
                sampledRequestsEnabled: true,
            },
            name: 'playtesting-cf-waf',
            rules: [{
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
                    metricName: 'MetricForGameCastCF-CRS',
                    sampledRequestsEnabled: true,
                },
                overrideAction: {
                    none: {}
                },
            }, {
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
                    metricName: 'MetricForGameCastCF-IpReputation',
                    sampledRequestsEnabled: true,
                },
                overrideAction: {
                    none: {}
                },
            }, {
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
                action: {
                    block: {}
                },
            }]
        });
        acl.addDeletionOverride(cdk.RemovalPolicy.DESTROY)
        return acl
    }
}
