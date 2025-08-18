import React from "react";
import { useNavigate } from "react-router-dom";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Link from "@cloudscape-design/components/link";
import Alert from "@cloudscape-design/components/alert";
import Wizard from "@cloudscape-design/components/wizard";
import Input from "@cloudscape-design/components/input";
import DatePicker from "@cloudscape-design/components/date-picker";
import Checkbox from "@cloudscape-design/components/checkbox";
import FormField from "@cloudscape-design/components/form-field";
import Button from "@cloudscape-design/components/button";
import TimeInput from "@cloudscape-design/components/time-input";

import { post, get, put } from "aws-amplify/api";
import S3ResourceSelector from "@cloudscape-design/components/s3-resource-selector";
import { S3ResourceSelectorProps } from "@cloudscape-design/components/s3-resource-selector";
import { fetchAuthSession } from "aws-amplify/auth";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import { RadioGroup, Select, Table, TableProps } from "@cloudscape-design/components";
import Modal from "@cloudscape-design/components/modal";
import Box from "@cloudscape-design/components/box";

type Bucket = S3ResourceSelectorProps.Bucket; // Alias to match Cloudscape's type

type GLS_Application = {
    Id: string;
    Description: string;
};

type CapacityItem = {
    location: string;
    alwaysOn: number;
    onDemand: number;
};

class AddNewPlayTest extends React.Component<{ navigate: (path: string) => void }, any> {
    constructor(props: { navigate: (path: string) => void }) {
        super(props);
        this.state = {
            activeStepIndex: 0, // Track the current step in the wizard
            name: "",
            game: "",
            studio: "",
            selectedS3Path: "",
            executionS3Path: "",
            s3Buckets: [],
            startDate: "",
            endDate: "",
            enabled: false,
            observations: [""],
            selectedOption: "",
            runtimeEnvironment: { label: "", value: "" }, // Ensure it matches the expected format
            applicationSelected: { label: "", value: "" }, // Ensure it matches the expected format
            sg_description: "",
            sg_class: "",
            capacityConfig: [
                { location: 'us-west-1', alwaysOn: 1, onDemand: 1 },
                { location: 'us-east-1', alwaysOn: 1, onDemand: 1 },
                { location: 'us-east-2', alwaysOn: 1, onDemand: 1 },
                { location: 'ap-northeast-1', alwaysOn: 1, onDemand: 1 },
                { location: 'eu-central-1', alwaysOn: 1, onDemand: 1 },
                { location: 'eu-west-1', alwaysOn: 1, onDemand: 1 },
            ],
            selectedLocations: ['us-east-2'], // must have at least one
            startTime: "",
            applicationOptions: [],
            step1Validated: false,
            step2Validated: false,
            step3Validated: false,
            step4Validated: false,
            step5Validated: false,
            showSuccessModal: false,
        };
    }

    async componentDidMount() {
        const apps = await this.getGLApplications();
        const options = apps.map(app => ({
            label: app.Description,
            value: app.Id,
        }));
        this.setState({ applicationOptions: options });
    }


    //get's GL Stream applications
    getGLApplications = async (): Promise<GLS_Application[]> => {
        try {

            const restOperation = get({
                apiName: "playtesting-api",
                path: "/playtestListGLApplications",
                options: {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}` } },
            });

            const response = await restOperation.response;
            const responseBody = (await response.body.json());

            //I need to parse out the "Id" and "Description" from responseBody into a new GSL_Application Object, but if responseBody is null then default to an empty GSL_Application object.
            const formattedApplications: GLS_Application[] =
                Array.isArray(responseBody)
                    ? responseBody.map((app: any) => ({
                        Id: app.Id,
                        Description: app.Description,
                    }))
                    : [];



            return formattedApplications || [];
        }
        catch (err) {
            console.error("Error fetching applications:", err);
            return [];
        }
        
    }

    // Fetch S3 Buckets
fetchBuckets = async (): Promise<Bucket[]> => {
    try {

        const restOperation = get({
            apiName: "playtesting-api",
            path: "/GetS3Buckets",
            options: {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}` } },
        });

        const response = await restOperation.response; // Get API response
        const responseBody = (await response.body.json()) as { Name?: string }[]; // Explicitly type the response

        // Ensure responseBody is an array before mapping
        if (!Array.isArray(responseBody)) {
            throw new Error("Expected an array from API response, but got something else.");
        }

        // Map AWS SDK response to Cloudscape's expected format
        const formattedBuckets: Bucket[] = responseBody
            .filter((bucket): bucket is { Name: string } => !!bucket.Name)
            .map((bucket: any, index: number) => ({
                Name: bucket.Name || `Bucket-${index}`,
                //arn: `arn:aws:s3:::${bucket.Name}`,
                //uri: `s3://${bucket.Name}`,
                CreationDate: bucket.CreationDate,
                Region: "us-east-2",
            })) as Bucket[];

            //alert(JSON.stringify(formattedBuckets));

        // Store in state
        this.setState({ s3Buckets: formattedBuckets });

        return formattedBuckets;
    } catch (err) {
        console.error("Error fetching buckets:", err);
        return [];
    }
};

    fetchObjects = async (bucketName: string) => {
        
          try {

         const restOperation = post({
            apiName: "playtesting-api",
             path: "/GetS3BucketObjects",
             options: {
                 headers: {
                     "Content-Type": "application/json",
                     Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}` }, body: { bucketName: `${bucketName}` } },
        });
        
        const response = await restOperation.response;
        
            const textResponse = await response.body.text();
            const responseBody = JSON.parse(textResponse);

            return responseBody; // Returns an array of objects
        } catch (error) {
            console.error("Error fetching objects:", error);
            return [];
        }

    };

    fetchVersions = async (bucketName: string, objectKey: string) => {
        // Fetch versions of an object (customize as needed)
        return Promise.resolve([
            { VersionId: "v1", LastModified: "2022-01-01", Size: 1000 }
        ]);
    };

    // Handle form input changes
    handleInputChange = (field: string, value: string | boolean) => {
        this.setState({ [field]: value });
    };

    handleInputChangeRunTime = (field: string, value: { label: string; value: string }) => {
        this.setState({ [field]: value });
    };

    // Handle S3 path selection
    handleS3Select = (event: any) => {
        this.setState({ selectedS3Path: event.detail.resource.uri });
        //alert("Selected S3 Path: " + event.detail.resource.uri);
    };

    // Handle S3 path selection
    handleExecutionS3Select = (event: any) => {
        this.setState({ executionS3Path: event.detail.resource.uri });
        //alert("Selected S3 Path: " + event.detail.resource.uri);
    };

    // Handle S3 path selection
    handleRuntimeSelect = (event: any) => {
        this.setState({ executionS3Path: event.detail.resource.uri });
        //alert("Selected S3 Path: " + event.detail.resource.uri);
    };

    // Handle observations
    handleObservationChange = (index: number, value: string) => {
        const newObservations = [...this.state.observations];
        newObservations[index] = value;
        this.setState({ observations: newObservations });
    };

    addObservation = () => {
        this.setState({ observations: [...this.state.observations, ""] });
    };

    removeObservation = (index: number) => {
        const newObservations = [...this.state.observations];
        newObservations.splice(index, 1);
        this.setState({ observations: newObservations });
    };

    //Need a function that will format observations into the JSON structure needed for backend
    formatObservations = () => {
        return this.state.observations.map((obs: string, index: number) => ({
            id: index + 1,
            observation: obs,
            response: ""
        }));
    };



    // Submit the playtest session
    submitPlaytestSession = async () => {
        const payload = {
            name: this.state.name,
            game: this.state.game,
            studio: this.state.studio,
            s3Path: this.state.selectedS3Path,
            executionS3Path: this.state.executionS3Path,
            startDate: this.state.startDate,
            endDate: this.state.endDate,
            enabled: this.state.enabled,
            observations: this.formatObservations(),
            runtimeEnvironment: this.state.runtimeEnvironment.value,
            applicationSelected: this.state.applicationSelected.value,
            sg_description: this.state.sg_description,
            sg_class: this.state.sg_class,
            capacityConfig: this.state.capacityConfig,
            selectedLocations: this.state.selectedLocations,
            startTime: this.state.startTime,
        };

        //checking state
        //alert(JSON.stringify(payload));

        try {
            const restOperation = put({
                apiName: "playtesting-api",
                path: "/playtestsession",
                options: {
                    body: payload,
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}` },
                },
            });

            await restOperation.response;
            this.setState({ showSuccessModal: true });
            //this.props.navigate("/"); //Redirect back to PlaySessions after submission
        } catch (error) {
            console.error("Error creating playtest session:", error);
            alert("Failed to create playtest session.");
        }
    };

    isStep1Valid() {
        const { name, game, studio } = this.state;
        return name.trim() !== "" && game.trim() !== "" && studio.trim() !== "";
    }

    isStep2Valid() {

        const { selectedS3Path, executionS3Path, runtimeEnvironment, applicationSelected } = this.state;

        //we have selected the new option
        if (this.state.selectedOption === "add-new") {

            return runtimeEnvironment.value !== "" && selectedS3Path.trim() !== "" && executionS3Path.trim() !== "";

        }

        if (this.state.selectedOption === "select-existing") {

            //I need to return true if applicationSelected isn't empty
            return applicationSelected.value !== "";

        }

        return;

    }

    isStep3Valid() {
        const { sg_description, sg_class } = this.state;

        const descriptionPattern = /^[a-zA-Z0-9\-_.!+@/][a-zA-Z0-9\-_.!+@/ ]*$/;

        return (
            sg_description.trim() !== "" &&
            sg_class.value.trim() !== "" &&
            descriptionPattern.test(sg_description)
        );
    }


    isStep4Valid() {
        const { startDate, startTime, endDate } = this.state;
        return startDate.trim() !== "" && startTime.trim() !== "" && endDate.trim() !== "";
    }

    isStep5Valid() {
        const { observations } = this.state;

        if (observations.length !== 0) {

            for (let i = 0; i < observations.length; i++) {
                if (observations[i].trim() === "") {
                    return false;
                }
            }
        }

        return observations.length !== 0;
    }


    // Handle Wizard navigation
    handleNavigate = ({ detail }: { detail: { requestedStepIndex: number } }) => {

        //check for step 1 completeness
        if (this.state.activeStepIndex === 0) {
            this.setState({ step1Validated: true });

            //prevent going to Step 2 unless Step 1 is valid
            if (this.state.activeStepIndex === 0 && !this.isStep1Valid()) {
                return;
            }
        }

        //check for step 2 completeness
        if (this.state.activeStepIndex === 1) {
            this.setState({ step2Validated: true });

            //prevent going to Step 3 unless Step 2 is valid
            if (this.state.activeStepIndex === 1 && !this.isStep2Valid()) {
                return;
            }
        }

        //check for step 3 completeness
        if (this.state.activeStepIndex === 2) {
            this.setState({ step3Validated: true });

            //prevent going to Step 4 unless Step 3 is valid
            if (this.state.activeStepIndex === 2 && !this.isStep3Valid()) {
                return;
            }
        }

        //check for step 4 completeness
        if (this.state.activeStepIndex === 3) {
            this.setState({ step4Validated: true });

            //prevent going to Step 5 unless Step 4 is valid
            if (this.state.activeStepIndex === 3 && !this.isStep4Valid()) {
                return;
            }
        }

        //check for step 5 completeness
        if (this.state.activeStepIndex === 4) {
            this.setState({ step5Validated: true });

            //prevent going to Step 6 unless Step 5 is valid
            if (this.state.activeStepIndex === 4 && !this.isStep5Valid()) {
                return;
            }
        }

        this.setState({ activeStepIndex: detail.requestedStepIndex });
    };

    // Handle Cancel
    handleCancel = () => {
        if (window.confirm("Are you sure you want to cancel? All progress will be lost.")) {
            this.props.navigate("/psessions"); //Navigate back to PlaySessions
        }
    };

    getColumnDefinitions(): TableProps.ColumnDefinition<CapacityItem>[] {
        return [
            {
                id: 'location',
                header: 'Location',
                cell: item => item.location,
            },
            {
                id: 'alwaysOn',
                header: 'Always-On Capacity',
                cell: item => (
                    <Input
                        type="number"
                        value={item.alwaysOn.toString()}
                        onChange={({ detail }) => {
                            const updated = [...this.state.capacityConfig];
                            const index = updated.findIndex(i => i.location === item.location);
                            updated[index] = { ...updated[index], alwaysOn: parseInt(detail.value) || 0 };
                            this.setState({ capacityConfig: updated });
                        }}
                        disabled={!this.state.selectedLocations.includes(item.location)}
                    />
                )
            },
            {
                id: 'onDemand',
                header: 'On-Demand Capacity',
                cell: item => (
                    <Input
                        type="number"
                        value={item.onDemand.toString()}
                        onChange={({ detail }) => {
                            const updated = [...this.state.capacityConfig];
                            const index = updated.findIndex(i => i.location === item.location);
                            updated[index] = { ...updated[index], onDemand: parseInt(detail.value) || 0 };
                            this.setState({ capacityConfig: updated });
                        }}
                        disabled={!this.state.selectedLocations.includes(item.location)}
                    />
                )
            }
        ];
    };

    render() {
        return (
            <SpaceBetween size="m">
                <Container>
                    <Wizard
                        activeStepIndex={this.state.activeStepIndex}
                        onNavigate={this.handleNavigate}
                        onSubmit={this.submitPlaytestSession}
                        onCancel={this.handleCancel}
                        i18nStrings={{
                            stepNumberLabel: (stepNumber) => `Step ${stepNumber}`, //Fix applied
                            collapsedStepsLabel: (stepNumber, stepsCount) => `Step ${stepNumber} of ${stepsCount}`,
                            navigationAriaLabel: "Playtest Session Creation Steps",
                            cancelButton: "Cancel",
                            previousButton: "Back",
                            nextButton: "Next",
                            submitButton: "Create Playtest",
                        }}

                        steps={[
                            {
                                title: "Playtest Details",
                                content: (
                                    <SpaceBetween size="m">
                                        <FormField label="Playtest Name" errorText={this.state.step1Validated && this.state.name.trim() === "" ? "Name is required" : ""}>
                                            <Input value={this.state.name} onChange={({ detail }) => this.handleInputChange("name", detail.value)} />
                                        </FormField>
                                        <FormField label="Game" errorText={this.state.step1Validated && this.state.game.trim() === "" ? "Game is required" : ""}>
                                            <Input value={this.state.game} onChange={({ detail }) => this.handleInputChange("game", detail.value)} />
                                        </FormField>
                                        <FormField label="Studio" errorText={this.state.step1Validated && this.state.studio.trim() === "" ? "Studio is required" : ""}>
                                            <Input value={this.state.studio} onChange={({ detail }) => this.handleInputChange("studio", detail.value)} />
                                        </FormField>
                                        <FormField label="Enabled">
                                            <Checkbox
                                                checked={this.state.enabled}
                                                onChange={({ detail }) => this.handleInputChange("enabled", detail.checked)}
                                            >
                                                Enabled
                                            </Checkbox>
                                        </FormField>
                                    </SpaceBetween>
                                ),
                            },
                            {
                                title: "Game Details",
                                content: (
                                    <SpaceBetween size="m">
                                        <div>
                                            {/* Radio Group for selecting between new or existing game */}
                                            <FormField label="Select how you want to add a game:">
                                                <RadioGroup
                                                    onChange={({ detail }) => {
                                                        this.setState({ selectedOption: detail.value });
                                                    }}
                                                    value={this.state.selectedOption}
                                                    items={[
                                                        { value: "add-new", label: "Add New Game" },
                                                        { value: "select-existing", label: "Select Existing Game" }
                                                    ]}
                                                />
                                            </FormField>

                                            {/* Conditionally Render Input Field for New Game */}
                                            {this.state.selectedOption === "add-new" && (
                                                <div>
                                                <br/>
                                                    <FormField label="The path to your application folder in the S3 bucket." errorText={this.state.step2Validated && this.state.selectedS3Path.trim() === "" ? "S3 path is required" : ""}>
                                                        <S3ResourceSelector
                                                            onChange={this.handleS3Select}
                                                            resource={{ uri: this.state.selectedS3Path }}
                                                            fetchBuckets={this.fetchBuckets} // Now correctly returns a Promise<readonly Bucket[]>
                                                            fetchObjects={this.fetchObjects}
                                                            fetchVersions={this.fetchVersions}
                                                            bucketsVisibleColumns={["Name", "CreationDate"]}
                                                            selectableItemsTypes={[
                                                                "buckets",
                                                                "objects"
                                                            ]}
                                                            i18nStrings={{
                                                                inContextInputPlaceholder: "S3://bucketname/mygame/",
                                                                inContextSelectPlaceholder: "Select an S3 path",
                                                                inContextBrowseButton: "Browse S3",
                                                                inContextViewButton: "View",
                                                                inContextLoadingText: "Loading resources...",
                                                                modalTitle: "Select an S3 resource",
                                                                modalCancelButton: "Cancel",
                                                                modalSubmitButton: "Choose",
                                                                modalBreadcrumbRootItem: "S3 Buckets"
                                                            }}
                                                        />
                                                    </FormField>
                                                    <FormField label="The path to the executable file." errorText={this.state.step2Validated && this.state.executionS3Path.trim() === "" ? "Execution path is required" : ""}>
                                                        <S3ResourceSelector
                                                            onChange={this.handleExecutionS3Select}
                                                            resource={{ uri: this.state.executionS3Path }}
                                                            fetchBuckets={this.fetchBuckets} // Now correctly returns a Promise<readonly Bucket[]>
                                                            fetchObjects={this.fetchObjects}
                                                            fetchVersions={this.fetchVersions}
                                                            bucketsVisibleColumns={["Name", "CreationDate"]}
                                                            selectableItemsTypes={[
                                                                "buckets",
                                                                "objects"
                                                            ]}
                                                            i18nStrings={{
                                                                inContextInputPlaceholder: "S3://bucketname/mygame/binaries/win64/mygame.exe",
                                                                inContextSelectPlaceholder: "Select an S3 path",
                                                                inContextBrowseButton: "Browse S3",
                                                                inContextViewButton: "View",
                                                                inContextLoadingText: "Loading resources...",
                                                                modalTitle: "Select an S3 resource",
                                                                modalCancelButton: "Cancel",
                                                                modalSubmitButton: "Choose",
                                                                modalBreadcrumbRootItem: "S3 Buckets"
                                                            }}
                                                        />
                                                    </FormField>
                                                    <FormField label="Choose a runtime environment to run your software on." errorText={this.state.step2Validated && this.state.runtimeEnvironment.value === "" ? "Runtime is required" : ""}>
                                                        <Select
                                                            selectedOption={this.state.runtimeEnvironment}
                                                            onChange={({ detail }) => {
                                                                if (detail.selectedOption) {
                                                                    this.handleInputChangeRunTime("runtimeEnvironment", {
                                                                        label: detail.selectedOption.label ?? "", // Ensure label is always a string
                                                                        value: detail.selectedOption.value ?? ""  // Ensure value is always a string
                                                                    });
                                                                }
                                                            }}
                                                            options={[
                                                                { label: "Microsoft Windows Server 2022 Base", value: "{\"Type\": \"WINDOWS\",\"Version\": \"2022\"}" },
                                                                { label: "Ubuntu 22.04 LTS", value: "{\"Type\": \"UBUNTU\",\"Version\": \"22_04_LTS\"}" },
                                                                { label: "Proton 8.0-5", value: "{\"Type\": \"PROTON\",\"Version\": \"20241007\"}" },
                                                                { label: "Proton 8.0-2c", value: "{\"Type\": \"PROTON\",\"Version\": \"20230704\"}" },
                                                            ]}
                                                        />
                                                    </FormField>
                                                </div>
                                            )}

                                            {/* Conditionally Render Select Dropdown for Existing Games */}
                                            {this.state.selectedOption === "select-existing" && (
                                                <div>
                                                 <br />
                                                    <FormField label="Select an existing game:" errorText={this.state.step2Validated && this.state.applicationSelected.value === "" ? "Application is required" : ""}>
                                                    <Select
                                                            selectedOption={this.state.applicationSelected}
                                                        onChange={({ detail }) => {
                                                            if (detail.selectedOption) {
                                                                this.handleInputChangeRunTime("applicationSelected", {
                                                                    label: detail.selectedOption.label ?? "", // Ensure label is always a string
                                                                    value: detail.selectedOption.value ?? ""  // Ensure value is always a string
                                                                });
                                                            }
                                                        }}
                                                            options={this.state.applicationOptions}
                                                    />
                                                    </FormField>
                                                </div>
                                            )}
                                        </div>
                                    </SpaceBetween>
                                ),
                            },
                            {
                                title: "Streaming Details",
                                content: (
                                    <SpaceBetween size="m">
                                        <FormField label="Short Description" errorText={this.state.step3Validated ? "Description is required.  Also needs may need to check punctuation as those fields are limited." : ""}>
                                            <Input value={this.state.sg_description} onChange={({ detail }) => this.handleInputChange("sg_description", detail.value)} />
                                        </FormField>
                                        <FormField label="Select stream class:" errorText={this.state.step3Validated && this.state.sg_class === "" ? "Stream class is required" : ""}>
                                            <Select
                                                selectedOption={this.state.sg_class}
                                                onChange={({ detail }) => {
                                                    if (detail.selectedOption) {
                                                        this.handleInputChangeRunTime("sg_class", {
                                                            label: detail.selectedOption.label ?? "", // Ensure label is always a string
                                                            value: detail.selectedOption.value ?? ""  // Ensure value is always a string
                                                        });
                                                    }
                                                }}
                                                options={[
                                                    { label: "gen5n_win2022  (Microsoft Windows Server 2022 Base) GPU: NVIDIA A10G Tensor Core", value: "gen5n_win2022" },
                                                    { label: "gen4n_win2022  (Microsoft Windows Server 2022 Base) GPU: NVIDIA T4 Tensor Core", value: "gen4n_win2022" },
                                                    { label: "gen5n_ultra  (Proton, Ubuntu 22.04 LTS) GPU: NVIDIA A10G Tensor Core", value: "gen5n_ultra" },
                                                    { label: "gen4n_ultra  (Proton, Ubuntu 22.04 LTS) GPU: NVIDIA T4 Tensor Core", value: "gen4n_ultra" },
                                                    { label: "gen5n_high  (Proton, Ubuntu 22.04 LTS) GPU: NVIDIA A10G Tensor Core", value: "gen5n_high" },
                                                    { label: "gen4n_high  (Proton, Ubuntu 22.04 LTS) GPU: NVIDIA T4 Tensor Core", value: "gen4n_high" }
                                                ]}
                                            />
                                        </FormField>
                                        <FormField label="Stream Configuration">
                                            <Table
                                                header="Capacity Configuration"
                                                items={this.state.capacityConfig}
                                                selectedItems={this.state.capacityConfig.filter((item: CapacityItem) =>
                                                    this.state.selectedLocations.includes(item.location)
                                                )}
                                                onSelectionChange={({ detail }) => {
                                                    const selected = (detail.selectedItems as CapacityItem[]).map((i: CapacityItem) => i.location);
                                                    this.setState({ selectedLocations: selected.length ? selected : this.state.selectedLocations });
                                                }}
                                                selectionType="multi"
                                                columnDefinitions={this.getColumnDefinitions()}
                                            />

                                        </FormField>
                                    </SpaceBetween>
                                ),
                            },
                            {
                                title: "Select Dates and Time",
                                content: (
                                    <SpaceBetween size="m">
                                        <FormField label="Start Date" errorText={this.state.step4Validated && this.state.startDate === "" ? "Start date is required" : ""}>
                                            <DatePicker value={this.state.startDate} onChange={({ detail }) => this.handleInputChange("startDate", detail.value)} />
                                        </FormField>
                                        <FormField label="Start Time" errorText={this.state.step4Validated && this.state.startTime === "" ? "Start time is required" : ""}>
                                            <TimeInput
                                                onChange={({ detail }) => this.handleInputChange("startTime", detail.value)}
                                                value={this.state.startTime}
                                                format="hh:mm"
                                                placeholder="hh:mm"
                                            />
                                        </FormField>
                                        <FormField label="End Date" errorText={this.state.step4Validated && this.state.endDate === "" ? "End date is required" : ""}>
                                            <DatePicker value={this.state.endDate} onChange={({ detail }) => this.handleInputChange("endDate", detail.value)} />
                                        </FormField>
                                    </SpaceBetween>
                                ),
                            },
                            {
                                title: "Observations",
                                content: (
                                    <SpaceBetween size="m">
                                        {this.state.observations.map((obs: string, index: number) => (
                                            <div key={index} style={{ display: "flex", alignItems: "center" }} >
                                                <FormField errorText={this.state.step5Validated && obs.trim() === "" ? "Observation is required" : ""} stretch>
                                                    <Input value={obs} onChange={({ detail }) => this.handleObservationChange(index, detail.value)} />
                                                </FormField>
                                                <Button onClick={() => this.removeObservation(index)} iconName="close" variant="icon" />
                                            </div>
                                        ))}
                                        <Button onClick={this.addObservation}>Add Observation</Button>
                                    </SpaceBetween>
                                ),
                            },
                            {
                                title: "Confirm & Submit",
                                content: (
                                    <SpaceBetween size="m">
                                        <Alert statusIconAriaLabel="Info">Please review your details before submitting.</Alert>
                                        <Button onClick={this.submitPlaytestSession} variant="primary">Create Playtest</Button>
                                    </SpaceBetween>
                                ),
                            },
                        ]}
                    />

                    <Modal
                        onDismiss={() => this.setState({ showSuccessModal: false })}
                        visible={this.state.showSuccessModal}
                        closeAriaLabel="Close modal"
                        header="Playtest Session Created"
                        footer={
                            <Box float="right">
                                <Button onClick={() => {
                                    this.setState({ showSuccessModal: false });
                                    this.props.navigate("/"); // or wherever you want to redirect
                                }} variant="primary">
                                    OK
                                </Button>
                            </Box>
                        }
                    >
                        <Box padding={{ bottom: "s" }}>
                            Your new playtest session has been created successfully.
                        </Box>
                    </Modal>

                </Container>
            </SpaceBetween>
        );
    }
}

//Wrap in a HOC to get `navigate` prop
export default function AddNewPlayTestWrapper() {
    const navigate = useNavigate();
    return <AddNewPlayTest navigate={navigate} />;
}
