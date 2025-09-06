/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */
import React from 'react';
import './Game.css';

import {
    Badge,
    Button,
    ButtonDropdown,
    ButtonDropdownProps,
    Container,
    CopyToClipboard,
    Header,
    SpaceBetween
} from "@cloudscape-design/components";

import * as gameliftstreamssdk from '../gl-streamsSDK/gameliftstreams-1.0.0';

import {ApiError, post, get} from 'aws-amplify/api';
import {fetchAuthSession} from "aws-amplify/auth";

interface GameProps {
    gameName: string,
    gameDescription: string,
    appId: string,
    sgId: string,
    region: string,
    setError: (error: string) => void
}

enum StreamState {
    STOPPED = 1,
    LOADING,
    RUNNING,
    ERROR
}

interface GameState {
    status: StreamState,
    pointerLocked: boolean,
    inputEnabled: boolean,
    error: string,
    micro: boolean,
    arn: string,
    regions: string[]
}

class GamePT extends React.Component<GameProps, GameState> {
    gameliftstreams?: gameliftstreamssdk.GameLiftStreams;

    constructor(props: GameProps) {
        super(props);
        this.state = {
            status: StreamState.STOPPED,
            pointerLocked: false,
            error: "",
            micro: false,
            arn: "",
            regions: [props.region],
            inputEnabled: false
        };
        
        //gamecastsdk.setLogLevel('debug');
        this.createStreamSession = this.createStreamSession.bind(this);
        this.enableFullScreen = this.enableFullScreen.bind(this);
        this.closeConnection = this.closeConnection.bind(this);
        this.enableInput = this.enableInput.bind(this);
        this.enablePointerLock = this.enablePointerLock.bind(this);
        this.enableMic = this.enableMic.bind(this);
        this.onButtonDropdownItemClick = this.onButtonDropdownItemClick.bind(this);
    }

    componentDidUpdate(prevProps: GameProps) {
        // Check if region prop has changed
        if (prevProps.region !== this.props.region) {
            // Update the regions array with the new region
            this.setState({
                regions: [this.props.region]
            });

            // If stream is running, close it and restart with new region
            if (this.state.status === StreamState.RUNNING) {
                this.closeConnection();
                // Optional: Automatically restart the stream with new region
                // setTimeout(() => this.createStreamSession(), 500);
            }
        }
    }

    private getVideoElement(): HTMLVideoElement {
        return document.getElementById(`StreamVideoElement${this.props.gameName}${this.props.sgId}`) as HTMLVideoElement;
    }

    private getAudioElement(): HTMLAudioElement {
        return document.getElementById(`StreamAudioElement`) as HTMLAudioElement;
    }

    componentDidMount() {
        const element = this.getVideoElement();
        this.gameliftstreams = new gameliftstreamssdk.GameLiftStreams({
            videoElement: element,
            audioElement: this.getAudioElement(),
            inputConfiguration: {
                setCursor: 'visibility',
                autoPointerLock: 'fullscreen'
            },
            clientConnection: {
                /*
                connectionState: this.streamConnectionStateCallback,
                channelError: this.streamChannelErrorCallback,
                serverDisconnect: this.streamServerDisconnectCallback
                */
            }
        });
    }

    async createStreamSession() {
        this.setState({status: StreamState.LOADING});
        const signalRequest = await this.gameliftstreams?.generateSignalRequest();
        try {
            const restOperation = post({
                apiName: "playtesting-api",
                path: "/",
                options: {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                    body: {
                        AppIdentifier: this.props.appId,
                        SGIdentifier: this.props.sgId,
                        //UserId: "DefaultUser", //this.state.userId,
                        SignalRequest: signalRequest ?? "",
                        Regions: this.state.regions   
                    }
                }
            })
            const {body} = await restOperation.response;
            const data = JSON.parse(await body.text());
            await this.waitForACTIVE(data.arn, this.props.sgId);
        } catch (e) {
            console.log(e)
            if (e instanceof ApiError) {
                if (e.response) {
                    const {statusCode, body} = e.response;
                    const data = JSON.parse(body ?? "");
                    console.error(`Received ${statusCode} error response with payload: ${body}`);
                    this.props.setError(data.message)
                    this.setState({status: StreamState.ERROR});
                }
            }
        }
    }

    async waitForACTIVE(arn: string, sg: string, timeoutMs: number = 600000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) { // while not timedout
            console.log(`Waiting for stream session: ${arn}`);
            try {
                const restOperation = get({
                    apiName: 'playtesting-api',
                    path: `/session/${encodeURIComponent(sg)}/${encodeURIComponent(arn)}`,
                    options: {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                        }
                    }
                });
                const { body } = await restOperation.response;
                const data = JSON.parse(await body.text());

                if (data.status === 'ACTIVE') { // the session is ACTIVE and we can connect
                    await this.gameliftstreams?.processSignalResponse(data.signalResponse);
                    this.gameliftstreams?.attachInput();
                    this.setState((prevState) => ({
                        ...prevState,
                        status: StreamState.RUNNING,
                        arn: arn
                    }));
                    return; // session is started, state is set for it so we can return
                }
                // else we wait for 1s and loop again
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                this.handleError(e);
                return;
            }
        }
        // timed out
        this.handleTimeout(arn);
    }

    private handleTimeout(arn: string) {
        const message = `Timeout in waiting for Stream Session: ${arn}`;
        console.error(message);
    }

    private handleError(e: any) {
        console.log(e);
        if (e instanceof ApiError) {
            if (e.response) {
                const { statusCode, body } = e.response;
                console.error(`Received ${statusCode} error response with payload: ${body}`);
            }
        }
    }

    enableFullScreen() {
        const element = this.getVideoElement()
        if (element) {
            this.gameliftstreams?.attachInput()
            this.setState({inputEnabled: true})
            element.requestFullscreen();
            // Use Keyboard API to set a "long hold" escape from fullscreen
            // if the browser supports this API (note that Safari does not)

            // @ts-ignore
            if (navigator.keyboard) {
                // @ts-ignore
                const keyboard = navigator.keyboard;
                keyboard.lock(["Escape"]);
            }
        }
    }

    closeConnection() {
        this.setState({status: StreamState.STOPPED, micro: false, arn: "", inputEnabled: false});
        this.gameliftstreams?.close();
        const element = this.getVideoElement();
        this.gameliftstreams = new gameliftstreamssdk.GameLiftStreams({
            videoElement: element,
            audioElement: this.getAudioElement(),
            inputConfiguration: {
                setCursor: 'visibility',
                autoPointerLock: 'fullscreen'
            }
        })
    }

    onButtonDropdownItemClick(details: CustomEvent<ButtonDropdownProps.ItemClickDetails>) {
        switch (details.detail.id) {
            case "epl":
                this.enablePointerLock();
                break;
            case "input":
                this.enableInput();
                break;
            case "micro":
                this.enableMic();
                break;
        }
    }

    enableInput() {
        if (!this.state.inputEnabled) {
            this.gameliftstreams?.attachInput();
            this.setState({inputEnabled: true})
        } else {
            this.gameliftstreams?.detachInput();
            this.setState({inputEnabled: false})
        }
    }

    async enableMic() {
        try {
            await this.gameliftstreams!.enableMicrophone();
            this.setState({micro: true});
        } catch (e) {
            console.log(e)
        }
    }

    enablePointerLock() {
        const element = this.getVideoElement();
        if (element && !this.state.pointerLocked) {
            element.requestPointerLock();
            this.setState({pointerLocked: true})
        } else {
            document.exitPointerLock();
            this.setState({pointerLocked: false})
        }
    }

    private getButtonDropdownItems() {
        const {status, inputEnabled, micro} = this.state;
        const isRunning = status === StreamState.RUNNING;
        const isStopped = status === StreamState.STOPPED;

        return [
            {
                text: 'Enable Pointer Lock',
                id: 'epl',
                disabled: !isRunning,
            },
            {
                text: inputEnabled ? 'Disable Input' : 'Enable Input',
                id: 'input',
                disabled: !isRunning,
            },
            {
                text: micro ? 'Disable Microphone' : 'Enable Microphone',
                id: 'micro',
                disabled: !isStopped,
            },
            {
                text: 'Get RTC Statistics',
                id: 'stats',
                disabled: !isRunning,
            },
        ];
    };

    render() {
        return <Container
            disableContentPaddings={true}
            header={
                <Header
                    variant="h2"
                    description={this.props.gameDescription}
                    actions={
                        <SpaceBetween direction="horizontal" size="m">
                            <Badge>{this.props.region}</Badge>
                            <Button loading={this.state.status === StreamState.LOADING}
                                    onClick={this.state.status !== StreamState.RUNNING ? this.createStreamSession : this.closeConnection}
                                    variant={this.state.status !== StreamState.RUNNING ? "primary" : "normal"}>
                                {this.state.status !== StreamState.RUNNING ? "Start Stream" : "End Stream"}
                            </Button>
                            <ButtonDropdown items={this.getButtonDropdownItems()}
                                            onItemClick={this.onButtonDropdownItemClick}>
                                Options
                            </ButtonDropdown>
                        </SpaceBetween>
                    }>
                    {`${this.props.gameName}`}
                </Header>
            }
            footer={this.state.status === StreamState.RUNNING ?
                <SpaceBetween direction="horizontal" size="xs">
                    <Badge>
                        <CopyToClipboard copySuccessText={"ARN copied"}
                                         copyErrorText={"ARN failed to copy"}
                                         textToCopy={this.state.arn} variant="inline"/>
                    </Badge>
                    <Badge>
                        <CopyToClipboard copySuccessText={"Region copied"}
                                         copyErrorText={"Region failed to copy"}
                                         textToCopy={this.state.regions[0]} variant="inline"/>
                    </Badge>
                </SpaceBetween> : null
            }>

            <div style={{position: 'relative'}}>
                <video
                    id={`StreamVideoElement${this.props.gameName}${this.props.sgId}`}
                    autoPlay
                    playsInline
                    style={{
                        width: this.state.status !== StreamState.STOPPED ? "100%" : "0%",
                        height: this.state.status !== StreamState.STOPPED ? "100%" : "0%"
                    }}
                />
                <audio id={'StreamAudioElement'} autoPlay></audio>
                {this.state.status !== StreamState.RUNNING ? null:
                    <div className="fullscreen">
                        <Button
                            className={'fullscreen-button'}
                            iconName="expand"
                            variant="icon"
                            onClick={this.enableFullScreen}
                            disabled={this.state.status !== StreamState.RUNNING}
                        />
                    </div>
                }
            </div>
        </Container>;
    }
}

export default GamePT;
