import * as React from "react";
import Textarea from "@cloudscape-design/components/textarea";
import TextContent from "@cloudscape-design/components/text-content";

interface ObservationProps {
    observation: string,
    id: string,
    response: string,
    setError: (error: string) => void,
    updateObservation: (id: string, response: string) => void
}

interface ObservationState {
    response: string;
}

class Observation extends React.Component<ObservationProps, ObservationState> {

    constructor(props: ObservationProps) {
        super(props);
        this.state = {
            response: props.response || "", // Initialize state
        };
    }

    handleChange = (event: { detail: { value: string } }) => {
        this.setState({ response: event.detail.value });
        this.props.updateObservation(this.props.id, event.detail.value);
    };

    componentDidMount() {
        //alert(("response: " + this.props.response));
    }


    render() {
        return (
            <div>
                <TextContent>
                    <h1>{this.props.observation}</h1>
                </TextContent>
                <Textarea
                    onChange={this.handleChange}
                    value={this.state.response}
                    placeholder="Enter your response here"
                />
            </div>
        );
    }
}

export default Observation;