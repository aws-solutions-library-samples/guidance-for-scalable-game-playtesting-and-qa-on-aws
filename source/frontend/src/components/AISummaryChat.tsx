import React from "react";
import { Button, Container, Header, Flashbar } from "@cloudscape-design/components";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import PromptInput from "@cloudscape-design/components/prompt-input";
import Avatar from "@cloudscape-design/chat-components/avatar";
import { post, ApiError } from "aws-amplify/api";
import { fetchAuthSession } from "aws-amplify/auth";

interface AISummaryChatProps {
    observations: { id: string; observation: string; response: string }[];
    selectedSession: string | null;  // Assuming you pass the selected session here
}

interface AISummaryChatState {
    messages: { role: "user" | "ai"; message: string }[];
    userPrompt: string;
    loading: boolean;
    error: string;
}

class AISummaryChat extends React.Component<AISummaryChatProps, AISummaryChatState> {
    constructor(props: AISummaryChatProps) {
        super(props);
        this.state = {
            messages: [],
            userPrompt: "",
            loading: false,
            error: "", // Error state initialized
        };
    }

    // Function to call API using AWS Amplify's `post()`
    fetchAISummary = async () => {
        const { selectedSession, observations } = this.props;
        const { userPrompt } = this.state;

        // Check if a session is selected; if not, show an error in Flashbar
        if (!selectedSession) {
            this.setState({
                error: "Please select a playtest session before generating the summary.",
            });
            return;
        }

        if (!userPrompt.trim()) return;

        this.setState({ loading: true });

        const payload = {
            observations: observations.map((obs) => ({
                id: obs.id,
                observation: obs.observation,
                response: obs.response,
            })),
            userPrompt: userPrompt,
        };

        try {
            const restOperation = post({
                apiName: "playtesting-api",
                path: "/aisummary",
                options: {
                    body: payload,
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`
                    },
                },
            });

            const response = await restOperation.response;
            const textResponse = await response.body.text();
            const responseBody = JSON.parse(textResponse);

            const summary = responseBody.summary || "No summary generated.";

            // Update chat with AI response
            this.setState((prevState) => ({
                messages: [
                    ...prevState.messages,
                    { role: "user", message: userPrompt },
                    { role: "ai", message: summary },
                ],
                userPrompt: "", // Clear input after sending
                error: "", // Clear the error message after a successful response
            }));
        } catch (error: unknown) {
            console.error("Error fetching AI summary:", error);

            if (error instanceof Error) {
                console.error("Error Message:", error.message);
            }

            if ((error as ApiError)?.response) {
                console.error("Error Response Data:", (error as ApiError).response);
            }
        } finally {
            this.setState({ loading: false });

            // Hide the Flashbar after a delay
            setTimeout(() => {
                this.setState({ error: "" });
            }, 5000);
        }
    };

    render() {
        const { messages, userPrompt, loading, error } = this.state;

        return (
            <Container header={<Header variant="h3">AI-Powered Summary</Header>}>
                {/* Display Flashbar error if there's an error */}
                {error && (
                    <Flashbar
                        items={[
                            {
                                header: "Oh no! A wild error occurred!",
                                type: "error",
                                content: error,
                                dismissible: true,
                                dismissLabel: "Dismiss message",
                                onDismiss: () => {
                                    this.setState({ error: "" });
                                },
                            },
                        ]}
                    />
                )}

                <div>
                    {messages.map((msg, index) => (
                        <ChatBubble
                            key={index}
                            ariaLabel={`${msg.role === "user" ? "You" : "AI"
                                } at ${new Date().toLocaleTimeString()}`}
                            type={msg.role === "user" ? "outgoing" : "incoming"}
                            avatar={
                                msg.role === "ai" ? (
                                    <Avatar ariaLabel="AI" tooltipText="AI Assistant" initials="AI" />
                                ) : undefined
                            }
                        >
                            {msg.message}
                        </ChatBubble>
                    ))}
                </div>

                <PromptInput
                    value={userPrompt}
                    onChange={({ detail }) => this.setState({ userPrompt: detail.value })}
                    placeholder="Ask AI about these observations..."
                    disabled={loading}
                />

                <Button onClick={this.fetchAISummary} disabled={!userPrompt.trim() || loading} loading={loading}>
                    {loading ? "Generating..." : "Generate Summary"}
                </Button>
            </Container>
        );
    }
}

export default AISummaryChat;
