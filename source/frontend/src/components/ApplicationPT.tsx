/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import React from "react";
import { AppLayout, SplitPanel} from "@cloudscape-design/components";
import GamePT from "./GamePT"
import { WithAuthenticatorProps } from "@aws-amplify/ui-react/dist/types/components/Authenticator/withAuthenticator";

//Matt Added Below
import { ApiError, get } from 'aws-amplify/api';
import ObservationList from "./ObservationList";
import { fetchAuthSession } from "aws-amplify/auth";

interface ApplicationProps {
    signOut: any
}

interface ApplicationState {
    selectedRegions: string[],
    regions: { label: string, value: string, description: string }[]
}

//Needed for auto playing stream after validating playtester
let gameAppId = "";
let gameSgId = "";
let gameKey = "";

//needed for playtesting observations
let gameObservations = "";

class ApplicationPT extends React.Component<ApplicationProps & WithAuthenticatorProps, ApplicationState> {
    constructor(props: ApplicationProps) {
        super(props);

        this.isPlayerValid();
        
    }
   
        async isPlayerValid() {
        try {
            //pluck query strings
            const queryParams = new URLSearchParams(window.location.search);
            const playerId = queryParams.get("id");
            const sessionId = queryParams.get("sessionId");
            //alert(sessionId);

            const restOperation = get({
                apiName: "playtesting-api",
                path: "/validate/?id="+playerId+"&sessionId="+sessionId,
                options: {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    }
                }
            })
            let {body} = await restOperation.response;
            const isValid = JSON.parse(await body.text()) as boolean;
            if (isValid) {

                //if sessionId is not null then assign its value to gameKey
                if (sessionId != null) {
                    gameKey = sessionId;

                    //I need to split the sessionId by - into two different string.  The first being gameAppId and the Second being gameSgId.
                    const sessionIdSplit = sessionId.split("--");
                    gameAppId = sessionIdSplit[1];
                    gameSgId = sessionIdSplit[0];

                }

                //Now we need to get any observations that a playtester will supply comments on
                const restOperation2 = get({
                    apiName: "playtesting-api",
                    path: "/playtestsessionobservations/?id=" + gameKey,
                    options: {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                        }
                    }
                })
                //Now i need to get the response and print it out in an alert
                let { body: body2 } = await restOperation2.response;
                gameObservations = await body2.text();
            }



            //this.setState({loading: false, games: JSON.parse(await body.text()) as GameData[]});
        } catch (error) {
            console.error('Error validating player:', error);

            if (error instanceof ApiError && error.response) {
                const {statusCode, body} = error.response;
                console.error(`API Error: ${statusCode} - ${body}`);
            }

            //this.setState({loading: false, error: 'Failed to fetch games'});
        }
    }


    setError(error: string) {
        console.log("Setting error", error)
    }

    render() {

        let parsedObservations: { observation: string; id: string; response: string; }[] = [];
        if (gameObservations && typeof gameObservations === "string" && gameObservations.trim() !== "") {

            //First, parse the outer JSON object
            const parsedObject = JSON.parse(gameObservations);


            //Then, parse the inner "Observations" string (fix single quotes first)
            const cleanedJsonString = parsedObject.Observations.replace(/'/g, '"'); // Convert single quotes to double quotes
            parsedObservations = JSON.parse(cleanedJsonString);
        }

        return (
            <AppLayout
                    toolsHide={true}
                navigationHide={true}
                contentType = "table"
                    content={<GamePT key={gameKey} gameName="Playtesting Session" gameDescription="Please fill out your testing outcomes and observations down below as you play." appId={gameAppId}
                        sgId={gameSgId} region="us-east-2" setError={this.setError} /> }
                    splitPanel={
                        <SplitPanel header="Testing Outcomes" >
                            <ObservationList observations={parsedObservations} />
                        </SplitPanel>
                    }
                />
        )
    }
}

export default ApplicationPT;
