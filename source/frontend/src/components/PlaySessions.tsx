import React from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Link from "@cloudscape-design/components/link";
import Alert from "@cloudscape-design/components/alert";
import { ApiError, get, post, del as apiDelete } from 'aws-amplify/api';
import Table from "@cloudscape-design/components/table";
import Input from "@cloudscape-design/components/input";
import DatePicker from "@cloudscape-design/components/date-picker";
import Checkbox from "@cloudscape-design/components/checkbox";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import TimeInput from "@cloudscape-design/components/time-input";

import Modal from "@cloudscape-design/components/modal";
import Box from "@cloudscape-design/components/box";


import { withRouter } from "./Utility/withRouter";
import { fetchAuthSession } from "aws-amplify/auth";

interface PlaySessionsProps {
    navigate: (path: string) => void; //Add navigate prop
}

interface PlaySessionsState {
    playtestSessions: PlaytestSession[];
    selectedSessionID: string | null;
    selectedSessionData: PlaytestSession | null;
    newObservation: string;
    showDeleteModal: boolean;
    updateSuccessMessage: string | null;
    updateErrorMessage: string | null;
}

interface Observation {
    observation: string;
    response?: string;
}

interface PlaytestSession {
    enabled: boolean;
    playtestingID: string;
    endDate: string;
    name: string;
    startDate: string;
    startTime: string;
    game: string;
    studio: string;
    observations: Observation[];
}

class PlaySessions extends React.Component<PlaySessionsProps, PlaySessionsState> {
    constructor(props: PlaySessionsProps) {
        super(props);
        this.state = {
            playtestSessions: [],
            selectedSessionID: null,
            selectedSessionData: null,
            newObservation: "",
            showDeleteModal: false,
            updateSuccessMessage: null,
            updateErrorMessage: null,
        };
    }

    // Navigate to AddNewPlayTest.tsx
    navigateToAddNew = () => {
        this.props.navigate("/addplaytest"); //Use navigate prop instead of history.push()
    };

    // Fetch data after component mounts
    async componentDidMount() {
        try {
            const restOperation = get({
                apiName: "playtesting-api",
                path: "/playtestsession/",
                options: {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                },
            });

            const response = await restOperation.response;
            const responseBody = response.body ? (await response.body.json()) as { Items?: PlaytestSession[] } : {};

            const playtestSessions = responseBody.Items?.map(session => ({
                ...session,
                observations: (() => {
                    try {
                        if (typeof session.observations === "string") {
                            console.log("Raw observations string from API:", session.observations); // Debug log

                            //Ensure observations is treated as a string
                            const fixedJson = (session.observations as string).replace(/'/g, '"');

                            return JSON.parse(fixedJson);
                        }
                        if (Array.isArray(session.observations)) {
                            return session.observations; // Use as-is if it's already an array
                        }
                        return []; // Default to empty array if invalid
                    } catch (error) {
                        console.error("Error parsing observations for session:", session.playtestingID, error);
                        return []; // Return empty array on failure
                    }
                })()
            })) ?? [];

            this.setState({ playtestSessions });
        } catch (error) {
            console.error("Error fetching playtest sessions:", error);
        }
    }




    // Handle Session Selection
    handleSessionSelect = ({ detail }: { detail: { selectedItems: PlaytestSession[] } }) => {
        if (detail.selectedItems.length > 0) {
            const selectedSession = detail.selectedItems[0];

            // Ensure observations are properly set
            const observations = typeof selectedSession.observations === "string"
                ? JSON.parse(selectedSession.observations) // Parse if it's stored as a string
                : Array.isArray(selectedSession.observations)
                    ? selectedSession.observations
                    : []; // Default to empty array if it's invalid
            console.log("Selected session observations:", observations); //Log observations to check
            this.setState({
                selectedSessionID: selectedSession.playtestingID,
                selectedSessionData: { ...selectedSession, observations }, // Ensure observations are included
            });
        } else {
            this.setState({ selectedSessionID: null, selectedSessionData: null });
        }
    };


    // Handle Input Changes
    handleInputChange = (field: keyof PlaytestSession, value: string | boolean) => {
        if (this.state.selectedSessionData) {
            this.setState(prevState => ({
                selectedSessionData: { ...prevState.selectedSessionData!, [field]: value },
            }));
        }
    };


    // Handle Observation Editing
    handleObservationChange = (index: number, field: keyof Observation, value: string) => {
        this.setState(prevState => {
            if (!prevState.selectedSessionData) return null;

            const updatedObservations = [...prevState.selectedSessionData.observations];
            updatedObservations[index] = { ...updatedObservations[index], [field]: value };

            return {
                selectedSessionData: {
                    ...prevState.selectedSessionData,
                    observations: updatedObservations,
                },
            };
        });
    };


    // Add a New Observation
    addObservation = () => {
        if (!this.state.newObservation.trim()) return; // Don't add empty observations

        this.setState(prevState => ({
            selectedSessionData: prevState.selectedSessionData
                ? {
                    ...prevState.selectedSessionData,
                    observations: [
                        ...prevState.selectedSessionData.observations,
                        { observation: prevState.newObservation, response: "" },
                    ],
                }
                : null,
            newObservation: "", // Clear input
        }));
    };

    // Remove an Observation
    removeObservation = (index: number) => {
        this.setState(prevState => ({
            selectedSessionData: prevState.selectedSessionData
                ? {
                    ...prevState.selectedSessionData,
                    observations: prevState.selectedSessionData.observations.filter((_, i) => i !== index),
                }
                : null,
        }));
    };


    // Handle Update Button Click
    updatePlaytestSession = async () => {
        if (!this.state.selectedSessionData) return;
        //alert(JSON.stringify(this.state.selectedSessionData));
        try {
            const restOperation = post({
                apiName: "playtesting-api",
                path: "/playtestsession",
                options: {
                    body: this.state.selectedSessionData as any, // Send updated session data
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}` },
                },
            });

            await restOperation.response;

            this.setState({
                updateSuccessMessage: "Playtest session updated successfully.",
                updateErrorMessage: null,
            });

            this.props.navigate("/psessions"); //Redirect back to PlaySessions after submission
            console.log("Playtest session updated successfully!");
        } catch (error) {
            console.error("Error updating playtest session:", JSON.stringify(error));

            this.setState({
                updateSuccessMessage: null,
                updateErrorMessage: "Failed to update playtest session. Please try again.",
            });

        }
    };

    //Handle delete button click
    deletePlaytestSession = async () => {
        if (!this.state.selectedSessionID) return;

        try {
            const restOperation = apiDelete({
                apiName: "playtesting-api",
                path: `/playtestsession?playtestingID=${encodeURIComponent(this.state.selectedSessionID)}`,
                options: {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                },
            });

            await restOperation.response;
            console.log("Playtest session deleted successfully!");

            // Update the state to remove the deleted session
            this.setState(prevState => ({
                playtestSessions: prevState.playtestSessions.filter(session => session.playtestingID !== this.state.selectedSessionID),
                selectedSessionID: null,
                selectedSessionData: null,
            }));
        } catch (error) {
            console.error("Error deleting playtest session:", JSON.stringify(error));
        }
    };

    openDeleteModal = () => {
        this.setState({ showDeleteModal: true });
    };

    closeDeleteModal = () => {
        this.setState({ showDeleteModal: false });
    };


    render() {
        return (
            <SpaceBetween size="m">

                {this.state.updateSuccessMessage && (
                    <Alert type="success" onDismiss={() => this.setState({ updateSuccessMessage: null })}>
                        {this.state.updateSuccessMessage}
                    </Alert>
                )}

                {this.state.updateErrorMessage && (
                    <Alert type="error" onDismiss={() => this.setState({ updateErrorMessage: null })}>
                        {this.state.updateErrorMessage}
                    </Alert>
                )}


                <Container header={<Header variant="h2">Playtest Sessions</Header>}>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "10px" }}>
                        <SpaceBetween direction="horizontal" size="m">
                            <Button onClick={this.navigateToAddNew} variant="primary">Create New</Button>
                            <Button onClick={this.openDeleteModal} variant="primary" disabled={!this.state.selectedSessionID}>Delete</Button>
                        </SpaceBetween>
                    </div>
                    <br />
                    <Table
                        columnDefinitions={[
                            { id: "name", header: "Playtest Name", cell: (item) => item.name },
                            { id: "game", header: "Game", cell: (item) => item.game },
                            { id: "studio", header: "Studio", cell: (item) => item.studio },
                            { id: "startDate", header: "Start Date", cell: (item) => item.startDate },
                            { id: "endDate", header: "End Date", cell: (item) => item.endDate },
                            { id: "enabled", header: "Enabled", cell: (item) => (item.enabled ? "Yes" : "No") },
                        ]}
                        items={this.state.playtestSessions}
                        selectionType="single"
                        trackBy="playtestingID"
                        onSelectionChange={this.handleSessionSelect}
                        selectedItems={this.state.selectedSessionID ? this.state.playtestSessions.filter((session) => session.playtestingID === this.state.selectedSessionID) : []}
                    />
                    <br />

                    {this.state.selectedSessionData && (
                        <Container header={<Header variant="h3">Edit Playtest Session</Header>}>
                            <SpaceBetween size="m">
                                {/* Editable Fields */}
                                <FormField label="Playtest Name">
                                    <Input
                                        value={this.state.selectedSessionData.name}
                                        onChange={({ detail }) => this.handleInputChange("name", detail.value)}
                                    />
                                </FormField>

                                <FormField label="Game">
                                    <Input
                                        value={this.state.selectedSessionData.game}
                                        onChange={({ detail }) => this.handleInputChange("game", detail.value)}
                                    />
                                </FormField>

                                <FormField label="Studio">
                                    <Input
                                        value={this.state.selectedSessionData.studio}
                                        onChange={({ detail }) => this.handleInputChange("studio", detail.value)}
                                    />
                                </FormField>

                                <FormField label="Start Date">
                                    <DatePicker
                                        value={this.state.selectedSessionData.startDate}
                                        onChange={({ detail }) => this.handleInputChange("startDate", detail.value)}
                                    />
                                </FormField>

                                <FormField label="Start Time">
                                    <TimeInput
                                        onChange={({ detail }) => this.handleInputChange("startTime", detail.value)}
                                        value={this.state.selectedSessionData.startTime}
                                        format="hh:mm"
                                        placeholder="hh:mm"
                                    />
                                </FormField>

                                <FormField label="End Date">
                                    <DatePicker
                                        value={this.state.selectedSessionData.endDate}
                                        onChange={({ detail }) => this.handleInputChange("endDate", detail.value)}
                                    />
                                </FormField>

                                <FormField label="Enabled">
                                    <Checkbox
                                        checked={this.state.selectedSessionData.enabled}
                                        onChange={({ detail }) => this.handleInputChange("enabled", detail.checked)}
                                    >
                                        Enabled
                                    </Checkbox>
                                </FormField>

                                {/* Wrap Observations in a Separate Container */}
                                <Container header={<Header variant="h3">Observations</Header>} className="observations-container">
                                    {this.state.selectedSessionData.observations.map((obs, index) => (
                                        <div key={index} style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
                                            <Input
                                                value={obs.observation}
                                                onChange={({ detail }) => this.handleObservationChange(index, "observation", detail.value)}
                                            />
                                            <Button onClick={() => this.removeObservation(index)} iconName="close" variant="icon" />
                                        </div>
                                    ))}

                                    {/* Add New Observation */}
                                    <FormField label="New Observation">
                                        <Input
                                            value={this.state.newObservation}
                                            onChange={({ detail }) => this.setState({ newObservation: detail.value })}
                                            placeholder="Enter new observation"
                                        />
                                        <Button onClick={this.addObservation} variant="primary">Add Observation</Button>
                                    </FormField>
                                </Container>


                                {/* Update Button */}
                                <Button onClick={this.updatePlaytestSession} variant="primary">Update Playtest Session</Button>
                            </SpaceBetween>
                        </Container>
                    )}

                    <Modal
                        onDismiss={this.closeDeleteModal}
                        visible={this.state.showDeleteModal}
                        closeAriaLabel="Close modal"
                        footer={
                            <Box float="right">
                                <SpaceBetween direction="horizontal" size="xs">
                                    <Button variant="link" onClick={this.closeDeleteModal}>Cancel</Button>
                                    <Button
                                        variant="primary"
                                        onClick={async () => {
                                            await this.deletePlaytestSession();
                                            this.closeDeleteModal();
                                        }}
                                    >
                                        Confirm Delete
                                    </Button>
                                </SpaceBetween>
                            </Box>
                        }
                        header="Confirm Deletion"
                    >
                        Are you sure you want to delete this playtest session? This action cannot be undone.
                    </Modal>

                </Container>
            </SpaceBetween>
        );
    }
}

export default withRouter(PlaySessions);
