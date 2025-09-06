/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 */

import React from "react";
import { AppLayout, SplitPanel, Select, Modal, Box } from "@cloudscape-design/components";
import { NonCancelableCustomEvent } from '@cloudscape-design/components/internal/events';
import { SelectProps } from "@cloudscape-design/components/select";
import GamePT from "./GamePT"
import { WithAuthenticatorProps } from "@aws-amplify/ui-react/dist/types/components/Authenticator/withAuthenticator";
import { ApiError, get, post } from 'aws-amplify/api';
import ObservationList from "./ObservationList";
import { fetchAuthSession } from "aws-amplify/auth";

const AWS_REGIONS: { [key: string]: string } = {
    'us-east-1': 'US East (N. Virginia)',
    'us-east-2': 'US East (Ohio)',
    'us-west-1': 'US West (N. California)',
    'us-west-2': 'US West (Oregon)',
    'af-south-1': 'Africa (Cape Town)',
    'ap-east-1': 'Asia Pacific (Hong Kong)',
    'ap-south-1': 'Asia Pacific (Mumbai)',
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'ap-northeast-2': 'Asia Pacific (Seoul)',
    'ap-northeast-3': 'Asia Pacific (Osaka)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)',
    'ca-central-1': 'Canada (Central)',
    'eu-central-1': 'Europe (Frankfurt)',
    'eu-west-1': 'Europe (Ireland)',
    'eu-west-2': 'Europe (London)',
    'eu-west-3': 'Europe (Paris)',
    'eu-north-1': 'Europe (Stockholm)',
    'eu-south-1': 'Europe (Milan)',
    'me-south-1': 'Middle East (Bahrain)',
    'sa-east-1': 'South America (São Paulo)'
};

interface ApplicationProps {
    signOut: any
}

interface RegionOption {
    label: string;
    value: string;
    latency?: number;
}

interface ApplicationState {
    gameAppId: string,
    gameSgId: string,
    gameKey: string,
    gameObservations: string,
    selectedRegion: string,
    availableRegions: RegionOption[],
    loadingRegions: boolean,
    isValid: boolean,
    validationMessage: string,
    showValidationModal: boolean
}

class ApplicationPT extends React.Component<ApplicationProps & WithAuthenticatorProps, ApplicationState> {
    constructor(props: ApplicationProps) {
        super(props);
        this.state = {
            gameAppId: "",
            gameSgId: "",
            gameKey: "",
            gameObservations: "",
            selectedRegion: "us-east-2", // Default region
            availableRegions: [],
            loadingRegions: true,
            isValid: false,
            validationMessage: "",
            showValidationModal: false
        };

        // Bind methods
        this.isPlayerValid = this.isPlayerValid.bind(this);
        this.setError = this.setError.bind(this);
    }

    componentDidMount() {
        this.isPlayerValid();
        this.fetchAvailableRegions();
    }

    async isPlayerValid() {
        try {
            const queryParams = new URLSearchParams(window.location.search);
            const playerId = queryParams.get("id");
            const sessionId = queryParams.get("sessionId");

            const restOperation = get({
                apiName: "playtesting-api",
                path: "/validate/?id="+playerId+"&sessionId="+sessionId,
                options: {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    }
                }
            });
            
            let {body} = await restOperation.response;
            const validationResponse = JSON.parse(await body.text());
            
            this.setState({
                isValid: validationResponse.IsValid === "true",
                validationMessage: validationResponse.reason || "Access denied",
                showValidationModal: validationResponse.IsValid !== "true"
            });

            if (validationResponse.IsValid === "true") {
                if (sessionId != null) {
                    this.setState({ gameKey: sessionId });
                    const sessionIdSplit = sessionId.split("--");
                    this.setState({ gameAppId: sessionIdSplit[1], gameSgId: sessionIdSplit[0] });
                }

                const restOperation2 = get({
                    apiName: "playtesting-api",
                    path: "/playtestsessionobservations/?id="+playerId+"&sessionId="+sessionId,
                    options: {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                        }
                    }
                });
                let { body: body2 } = await restOperation2.response;
                this.setState({ gameObservations: await body2.text() });
            }

        } catch (error) {
            console.error('Error validating player:', error);
            if (error instanceof ApiError && error.response) {
                const {statusCode, body} = error.response;
                console.error(`API Error: ${statusCode} - ${body}`);
                this.setState({
                    isValid: false,
                    validationMessage: "An error occurred during validation",
                    showValidationModal: true
                });
            }
        }
    }

    setError(error: string) {
        console.error("Error:", error);
    }

    // Function to measure latency to a specific region
    private async measureRegionLatency(region: string): Promise<number> {
        const endpoint = `https://s3.${region}.amazonaws.com/`;
        const samples = 3;
        const timeout = 5000;
        
        const latencies: number[] = [];
        
        for (let i = 0; i < samples; i++) {
            try {
                const startTime = performance.now();
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);
                
                await fetch(endpoint, {
                    method: 'HEAD',
                    mode: 'no-cors',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                const latency = performance.now() - startTime;
                latencies.push(latency);
            } catch (error) {
                console.warn(`Failed to measure latency for region ${region}:`, error);
                latencies.push(Infinity);
            }
        }
        
        const sortedLatencies = latencies.sort((a, b) => a - b);
        return sortedLatencies[Math.floor(sortedLatencies.length / 2)];
    }

    async fetchAvailableRegions() {
        try {
            const queryParams = new URLSearchParams(window.location.search);
            const sessionId = queryParams.get("sessionId");

            if (!sessionId) {
                throw new Error("Session ID is required");
            }

            const restOperation = post({
                apiName: "playtesting-api",
                path: "/GetStreamGroupRegions",
                options: {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                    body: {
                        playtestsessionId: sessionId
                    }
                }
            });

            let { body } = await restOperation.response;
            const response = JSON.parse(await body.text());
            
            const regionOptions: RegionOption[] = response.Locations.map((region: string) => ({
                label: `${AWS_REGIONS[region] || region}`,
                value: region
            }));

            const regionsWithLatency = await Promise.all(
                regionOptions.map(async (region) => {
                    const latency = await this.measureRegionLatency(region.value);
                    return {
                        ...region,
                        label: `${region.label} (${Math.round(latency)}ms)`,
                        latency
                    };
                })
            );

            const sortedRegions = regionsWithLatency.sort((a, b) => 
                (a.latency || Infinity) - (b.latency || Infinity)
            );

            const bestRegion = sortedRegions[0]?.value || this.state.selectedRegion;

            this.setState({ 
                availableRegions: sortedRegions,
                loadingRegions: false,
                selectedRegion: bestRegion
            });

        } catch (error) {
            console.error('Error fetching regions:', error);
            this.setState({ loadingRegions: false });
        }
    }

    handleRegionChange = (event: NonCancelableCustomEvent<SelectProps.ChangeDetail>) => {
        if (event.detail.selectedOption.value) {
            this.setState({ selectedRegion: event.detail.selectedOption.value });
        }
    }

    render() {
        let parsedObservations: { observation: string; id: string; response: string; }[] = [];
        if (this.state.gameObservations && typeof this.state.gameObservations === "string" && this.state.gameObservations.trim() !== "") {
            const parsedObject = JSON.parse(this.state.gameObservations);
            parsedObservations = parsedObject.Observations;
        }

        return (
            <>
                <Modal
                    visible={this.state.showValidationModal}
                    closeAriaLabel="Close modal"
                    onDismiss={() => {}}  // Empty function since we don't want to allow dismissal
                    header="Access Denied"
                >
                    <Box color="text-status-error" padding="m">
                        {this.state.validationMessage}
                    </Box>
                </Modal>

                {this.state.isValid && (
                    <AppLayout
                        toolsHide={true}
                        navigationHide={true}
                        contentType="table"
                        content={
                            <div>
                                <div style={{ marginBottom: '20px', maxWidth: '300px' }}>
                                    <Select
                                        selectedOption={this.state.availableRegions.find(
                                            option => option.value === this.state.selectedRegion
                                        ) || { label: this.state.selectedRegion, value: this.state.selectedRegion }}
                                        onChange={this.handleRegionChange}
                                        options={this.state.availableRegions}
                                        placeholder="Choose a region"
                                        statusType={this.state.loadingRegions ? 'loading' : 'finished'}
                                        expandToViewport={true}
                                    />
                                </div>
                                <GamePT 
                                    key={this.state.gameKey} 
                                    gameName="Playtesting Session" 
                                    gameDescription="Please fill out your testing outcomes and observations down below as you play." 
                                    appId={this.state.gameAppId}
                                    sgId={this.state.gameSgId} 
                                    region={this.state.selectedRegion} 
                                    setError={this.setError} 
                                />
                            </div>
                        }
                        splitPanel={
                            <SplitPanel header="Testing Outcomes">
                                <ObservationList observations={parsedObservations} />
                            </SplitPanel>
                        }
                    />
                )}
            </>
        );
    }
}

export default ApplicationPT;
