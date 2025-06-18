/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import React from "react";
import Observation from "./Observation";
import {Flashbar, Grid, GridProps, SpaceBetween, Button} from "@cloudscape-design/components";
import {ApiError, post} from 'aws-amplify/api';

import * as awsui from '@cloudscape-design/design-tokens';
import { fetchAuthSession } from "aws-amplify/auth";

interface ObservationItem {
    id: string;
    observation: string;
    response: string;
}

interface ObservationListProps {
    observations: ObservationItem[];
}

interface ObservationListState {
    observations: ObservationItem[],
    error: string,
    statusCode: string

}

class ObservationList extends React.Component<ObservationListProps, ObservationListState> {
    constructor(props: ObservationListProps) {
        super(props);
        this.state = {
            observations: props.observations || [],
            error: "",
            statusCode: ""
        };

        this.setError = this.setError.bind(this);
    }

    componentDidMount() {
        //parse the observations prop into this.state.observations
        //const observations = this.props.observations
        //this.setState({ observations: observations })
        //alert(JSON.stringify(this.props.observations));
    }

    //Update state when new observations are received from the parent
    componentDidUpdate(prevProps: ObservationListProps) {
       // setTimeout(() => {
            if (prevProps.observations !== this.props.observations) {
                this.setState({ observations: this.props.observations });
            }
        //}, 100); // Simulated delay to ensure proper rendering
    }

    setError(error: string) {
        console.log("Setting error", error)
        this.setState({error: error})
    }

    //Update response field when user types in an observation
    updateObservation = (id: string, response: string) => {
        this.setState((prevState) => ({
            observations: prevState.observations.map((obs) =>
                obs.id === id ? { ...obs, response } : obs
            ),
        }) as ObservationListState); // Explicitly cast state update type
    };

    submitObservations = async () => {
        //pluck query strings
        const queryParams = new URLSearchParams(window.location.search);
        const Id = queryParams.get("id") || "";
        const sessionId = queryParams.get("sessionId") || "";
      
        //alert(JSON.stringify({ observations: this.state.observations }));

        //const jsonPayload = JSON.stringify({
        //    Id: playerId,
        //    sessionId: sessionId,
        //    myObservations: { observations: this.state.observations },
        //});
        //alert(jsonPayload);

        //Define the type structure explicitly
        interface RequestBody {
            Id: string;
            sessionId: string;
            myObservations: {
                observations: { id: string; observation: string; response: string }[];
            };
        }

        //Properly structured request body
        const requestBody: RequestBody = {
            Id,
            sessionId,
            myObservations: {
                observations: this.state.observations, // Ensure this is an array
            },
        };

        try {
            //alert(JSON.stringify(requestBody));
            const restOperation = post({
                apiName: "playtesting-api",
                path: "/playtester",
                options: {
                    body: requestBody as unknown as FormData, //Type casting to avoid TypeScript error
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                },
            });
            
            const response = await restOperation.response;
            

            //if response is not ok then throw an error
            if (response.statusCode !== 200) {
                throw new Error("Failed to submit observations");
            }

            //Now, we need to set statusCode equal to response.statusCode
            this.setState({ statusCode: response.statusCode.toString() });
            
        } catch (error) {
            if (error instanceof ApiError) {
                console.error("API Error:", error.response);
            } else {
                console.error("Unexpected Error:", error);
            }
        }
    }

    render() {
        //Now I need to map  this.state.myObservations to a list of Observation components
        const observationList = this.state.observations.map((obs) => (
            <Observation key={obs.id} id={obs.id} response={obs.response} observation={obs.observation} setError={this.setError} updateObservation={this.updateObservation} />
        ));
        
        return (
            <div>
                {this.state.error !== "" ? <Flashbar items={[{
                    header: "Oh no! A wild error occurred!",
                    type: "error",
                    content: this.state.error,
                    dismissible: true,
                    dismissLabel: "Dismiss message",
                    onDismiss: () => {
                        this.setState({error: ""})
                    },
                }]} /> : null}
                {this.state.statusCode === "200" ? <Flashbar items={[{
                    header: "Success!",
                    type: "success",
                    content: "Observation Successfully Submitted!",
                    dismissible: true,
                    dismissLabel: "Dismiss message",
                    onDismiss: () => {
                        this.setState({ statusCode: "" })
                    },
                }]} /> : null}

                <SpaceBetween direction="vertical" size="m">
                    <Grid gridDefinition={observationList.map(e => {
                        return { colspan: { default: 12 } } as GridProps.ElementDefinition
                    })}>
                        {observationList}
                    </Grid>
                    <Button onClick={this.submitObservations}>Submit Observations</Button>
                </SpaceBetween>
            </div>
        )
    }
}

export default ObservationList;
