import React from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Link from "@cloudscape-design/components/link";
import Alert from "@cloudscape-design/components/alert";

import { ApiError, get } from 'aws-amplify/api';
import Table from "@cloudscape-design/components/table";
import { Routes, Route } from "react-router-dom";
import { fetchAuthSession } from "aws-amplify/auth";
import Spinner from "@cloudscape-design/components/spinner";
import { StatusIndicator } from "@cloudscape-design/components";
import { Button } from "@cloudscape-design/components";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";

interface HomeProps {
    setSelectedSessionID: (id: string | null) => void;
    setFilteredObservations: (observations: { id: string; observation: string; response: string }[]) => void;
}

interface HomeState {
    playtestSessions: PlaytestSession[];
    playtesters: Playtester[]; //Store playtesters
    selectedSessionID: string | null; //Store selected session ID
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
    observations: string;
    status: string;
}

interface Playtester {
    playtesterID: string;
    playtestsessionID: string;
    playtesterName: string;
    recordedObservations: string;
}

class Home extends React.Component<HomeProps, HomeState> {

    pollingInterval: NodeJS.Timeout | undefined;

    constructor(props: HomeProps) {
        super(props);
        this.state = {
            playtestSessions: [],
            playtesters: [],
            selectedSessionID: null,
        };
    }

    fetchPlaytestSessions = async () => {
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

            this.setState({ playtestSessions: responseBody.Items ?? [] }); //Update state with fetched data
        } catch (error) {
            console.error("Error fetching playtest sessions:", error);
        }
    }

    //Fetch data after component mounts
    async componentDidMount() {
        this.fetchPlaytestSessions();
        this.pollingInterval = setInterval(this.fetchPlaytestSessions, 60000); // every 60 seconds
    }

    componentWillUnmount() {
        clearInterval(this.pollingInterval);
    }

    //Fetch Playtesters When a Session Is Selected
    fetchPlaytesters = async (sessionID: string) => {
        try {
            const restOperation = get({
                apiName: "playtesting-api",
                path: `/playtester?sessionID=${sessionID}`, //Query playtesters by sessionID
                options: {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                },
            });

            const response = await restOperation.response;
            const responseBody = response.body ? (await response.body.json()) as { Items?: Playtester[] } : {};
            
            //Filter observations only for the selected session
            const filteredObservations = responseBody.Items?.flatMap((pt) => {
                let observationsArray = [];

                try {
                    //Check if `recordedObservations` is a string, and parse it if needed
                    const recordedObservations = typeof pt.recordedObservations === "string"
                        ? JSON.parse(pt.recordedObservations)
                        : pt.recordedObservations;

                    //Ensure recordedObservations.observations exists
                    if (recordedObservations && recordedObservations.observations) {
                        observationsArray = recordedObservations.observations.map((obs: any) => ({
                            id: `${pt.playtesterID}-${obs.id}`,
                            observation: obs.observation,
                            response: obs.response || "",
                        }));
                    }
                } catch (error) {
                    console.error("Error parsing recordedObservations:", error);
                }

                return observationsArray;
            }) ?? [];

            //alert(JSON.stringify((filteredObservations)));
            this.props.setFilteredObservations(filteredObservations);

            this.setState({ playtesters: responseBody.Items ?? [] });
        } catch (error) {
            console.error("Error fetching playtesters:", error);
        }
    };

    //Handle Session Selection
    handleSessionSelect = ({ detail }: { detail: { selectedItems: PlaytestSession[] } }) => {
        if (detail.selectedItems.length > 0) {
            const selectedSessionID = detail.selectedItems[0].playtestingID;

            this.props.setSelectedSessionID(selectedSessionID);

            this.setState({ selectedSessionID }, () => {
                this.fetchPlaytesters(selectedSessionID); //Fetch playtesters when session is selected
            });
        } else {
            this.setState({ selectedSessionID: null, playtesters: [] }); //Clear playtesters if no session selected
            this.props.setSelectedSessionID(null);
            this.props.setFilteredObservations([]);
        }
    };

    render() {
        return (
            <SpaceBetween size="m">

                    <Header
                        variant="h2"
                        info={<Link variant="info">Info</Link>}
                        description="This solution will allow users to help organize and manage playtest sessions."
                    >
                        Welcome to the Playtesting
                    </Header>
                    <Alert statusIconAriaLabel="Info">
                        There are two groups below.  The first group will contain all playtest sessions that are current.  The second table will show after selecting a playtest session.  That table will show all associated playtesters
                    </Alert>

                <Container header={<Header variant="h2">Playtest Sessions</Header>}>

                    <Button
                        disabled={!this.state.selectedSessionID}
                        onClick={() => {
                            const idToCopy = this.state.selectedSessionID;
                            if (idToCopy) {
                                navigator.clipboard.writeText(idToCopy)
                                    .then(() => console.log("Copied:", idToCopy))
                                    .catch((err) => console.error("Copy failed:", err));
                            }
                        }}
                    >
                        Copy Session ID to Clipboard
                    </Button>


                    {/* Playtest Sessions Table */}
                    <Table
                        columnDefinitions={[
                            { id: "name", header: "Playtest Name", cell: (item) => item.name },
                            { id: "game", header: "Game", cell: (item) => item.game },
                            { id: "studio", header: "Studio", cell: (item) => item.studio },
                            { id: "startDate", header: "Start Date", cell: (item) => item.startDate },
                            { id: "startTime", header: "Start Time", cell: (item) => item.startTime },
                            { id: "endDate", header: "End Date", cell: (item) => item.endDate },
                            { id: "enabled", header: "Enabled", cell: (item) => (item.enabled ? "Yes" : "No") },
                            {
                                id: "status",
                                header: "Status",
                                cell: (item) => {
                                    const status = item.status.toLowerCase();

                                    let type: "success" | "warning" | "error" | "info" = "info";
                                    if (status === "initializing") type = "warning";
                                    else if (status === "active") type = "success";
                                    else if (status === "deleting") type = "warning";
                                    else if (status === "error") type = "error";

                                    return (
                                        <StatusIndicator type={type}>
                                            {(status === "initializing" || status === "deleting" ) && <Spinner size="normal" />}{" "}
                                            <span style={{ marginLeft: "0.5rem", textTransform: "capitalize" }}>{status}</span>
                                        </StatusIndicator>
                                    );
                                },
                            }
,
                        ]}
                        items={this.state.playtestSessions}
                        selectionType="single"
                        trackBy="playtestingID"
                        empty={<p>No playtest sessions available.</p>}
                        onSelectionChange={this.handleSessionSelect} //Handle selection
                        selectedItems={this.state.selectedSessionID ? this.state.playtestSessions.filter((session) => session.playtestingID === this.state.selectedSessionID) : []}
                    />
                    <br/>
                    {/* Render Playtesters Table Below If a Session Is Selected */}
                    {this.state.selectedSessionID && (
                        <Container header={<Header variant="h3">Playtesters</Header>}>
                            <Table
                                columnDefinitions={[
                                    { id: "playtesterName", header: "Playtester Name", cell: (item) => item.playtesterName },
                                    {
                                        id: "recordedObservations",
                                        header: "Recorded Observations",
                                        cell: (item) => {
                                            let observations: { observation: string; response: string; id: number }[] = [];

                                            try {
                                                // Check if recordedObservations is a string and parse it if necessary
                                                if (typeof item.recordedObservations === "string") {
                                                    const parsed = JSON.parse(item.recordedObservations); // Parse string to object

                                                    // Ensure the parsed object has 'observations' and it's an array
                                                    if (parsed && Array.isArray(parsed.observations)) {
                                                        observations = parsed.observations;
                                                    } else {
                                                        console.error("Expected observations array in parsed data");
                                                    }
                                                } else if (item.recordedObservations && Array.isArray(item.recordedObservations["observations"])) {
                                                    // If already an object with observations, use it directly
                                                    observations = item.recordedObservations["observations"];
                                                }
                                            } catch (error) {
                                                console.error("Error parsing recordedObservations:", error);
                                            }

                                            // Render observations if available
                                            return (
                                                <div>
                                                    {observations.length > 0 ? (
                                                        observations.map((obs, index) => (
                                                            <div key={index} style={{ marginBottom: '8px' }}>
                                                                <strong>Observation {obs.id}:</strong> {obs.observation}
                                                                <br />
                                                                <em>Response:</em> {obs.response}
                                                            </div>
                                                        ))
                                                    ) : (
                                                        <span>No observations available.</span>
                                                    )}
                                                </div>
                                            );
                                        }
                                    },
                                ]}
                                items={this.state.playtesters}
                                selectionType="single"
                                trackBy="playtesterID"
                                empty={<p>No playtesters available.</p>}
                            />

                        </Container>
                    )}
                </Container>
            </SpaceBetween >
        );
    }
}

export default Home;
