/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 *
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */

import React from "react";
import { AppLayout, SideNavigation, Button, ContentLayout, Header, SpaceBetween, HelpPanel, SplitPanel} from "@cloudscape-design/components";
import { WithAuthenticatorProps } from "@aws-amplify/ui-react/dist/types/components/Authenticator/withAuthenticator";

//Matt Added Below
import { Routes, Route } from "react-router-dom";
import Home from "./Home";
import PlaySessions from "./PlaySessions";
import AISummaryChat from "./AISummaryChat";
import AddNewPlayTest from "./AddNewPlayTest"

interface ApplicationProps {
    signOut: any
}

interface ApplicationState {
    selectedSessionID: string | null;
    filteredObservations: { id: string; observation: string; response: string }[];
}

class Application extends React.Component<ApplicationProps & WithAuthenticatorProps, ApplicationState> {
    constructor(props: ApplicationProps) {
        super(props);
        this.state = {
            selectedSessionID: null,
            filteredObservations: [],
        };
    }

    //Update state when a playtest session is selected
    setSelectedSessionID = (id: string | null) => {
        this.setState({ selectedSessionID: id });
    };

    //Update state with filtered observations
    setFilteredObservations = (observations: { id: string; observation: string; response: string }[]) => {
        this.setState({ filteredObservations: observations });
    };

    render() {

        return (
            <AppLayout navigationHide={false}
                navigation={
                    <SideNavigation
                        header={{
                            href: '/',
                            text: 'Playtesting Service',
                        }}
                        items={[{ type: 'link', text: `Dashboard`, href: `/dashboard` },
                            { type: 'link', text: `Manage Play Sessions`, href: `/psessions` }]
                        }
                        onFollow={(event) => {
                            event.preventDefault();
                            window.history.pushState(null, "", event.detail.href);
                            const navEvent = new PopStateEvent("popstate");
                            window.dispatchEvent(navEvent);
                        }}
                    />
                }
                toolsHide={false}
                toolsWidth={500}
                tools={<HelpPanel header={<h2>Observation Summarization</h2>}><AISummaryChat observations={this.state.filteredObservations} selectedSession={this.state.selectedSessionID} /></HelpPanel>}
                headerVariant="high-contrast" content={
                <ContentLayout
                        headerVariant="high-contrast"
                    header={
                        <SpaceBetween size="xl">
                            <Header
                                variant="h1"
                                description="Welcome to the Playtesting Service Demo."
                                actions={
                                    <SpaceBetween direction="horizontal" size="xs">
                                        <Button variant="primary" onClick={this.props.signOut}>Sign Out</Button>
                                    </SpaceBetween>
                                }>
                                Playtesting Demo
                            </Header>
                        </SpaceBetween>
                    }>
                        <br />
                        <br />

                        <SpaceBetween direction="vertical" size="m">
                            <Routes>
                                <Route path="/" element={<Home setSelectedSessionID={this.setSelectedSessionID} setFilteredObservations={this.setFilteredObservations} />} />
                                <Route path="/dashboard" element={<Home setSelectedSessionID={this.setSelectedSessionID} setFilteredObservations={this.setFilteredObservations} />} />
                                <Route path="/psessions" element={<PlaySessions />} />
                                <Route path="/addplaytest" element={<AddNewPlayTest />} />

                            </Routes>
                    </SpaceBetween>
                </ContentLayout>
            }
                
            />
        )
    }
}

export default Application;
