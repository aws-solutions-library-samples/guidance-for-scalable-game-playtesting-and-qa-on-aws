import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

//use process.env.CDK_DEFAULT_REGION instead of hardcoded value for dynamic reason
//will also need to consider creating an inference profile in the event your region needs a crossreference for model
const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });

export const handler = async (event) => {

    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "X-Requested-With": "*",
    };

    //Add Debug Logs for Incoming Request
    //console.log("Full Event Received by Lambda:", JSON.stringify(event, null, 2));
    //console.log("Event Body Before Parsing:", event.body);

    try {
        // Parse body as JSON first
        const requestBody = event.body ? JSON.parse(event.body) : {};
        //console.log("Parsed Request Body:", JSON.stringify(requestBody, null, 2));

        // Check if `observations` is still a string, and parse it if necessary
        let { observations, userPrompt } = requestBody;

        // If observations is a string (i.e., still stringified), parse it again
        if (typeof observations === "string") {
            observations = JSON.parse(observations);
        }

        if (!observations || observations.length === 0) {
            console.error("ERROR: Observations data is missing");
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Observations data is required." }),
                headers: headers
            };
        }

        // Log observations to verify the correct data
        //console.log("Observations Parsed Successfully:", JSON.stringify(observations, null, 2));

        //Format input for Claude 3 Haiku
        const formattedInput = formatObservations(observations, userPrompt);

        //console.log("Formatted Input:", formattedInput);

        //Invoke AWS Bedrock Claude 3 Haiku model
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-haiku-20240307-v1:0", //Correct model ID
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31", //Required field
                messages: [
                    { role: "user", content: formattedInput } //Only `user` role allowed
                ],
                max_tokens: 500,
                temperature: 0.7,
                top_p: 0.9
            }),
        });

        const response = await bedrockClient.send(command);
        //console.log("Bedrock Response:", JSON.stringify(response, null, 2));
        const responseBody = new TextDecoder().decode(response.body);
        //console.log("Bedrock Response Body:", responseBody);
        const parsedResponse = JSON.parse(responseBody);
        //console.log("Parsed Bedrock Response Body:", parsedResponse);

        //Extract AI-generated summary from response
        const aiSummary = parsedResponse?.content?.[0]?.text || "No response generated.";

        return {
            statusCode: 200,
            body: JSON.stringify({ summary: aiSummary }),
            headers: headers
        };

    } catch (error) {
        console.error("ERROR invoking Bedrock model:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal Server Error", details: error.message }),
            headers: headers
        };
    }
};

//Format observations into structured input
const formatObservations = (observations, userPrompt) => {
    return `
Observations:
${observations.map((obs) => `- ${obs.observation} (Response: ${obs.response})`).join("\n")}

User Question (if any): ${userPrompt || "N/A"}

Provide a concise, structured summary.
    `.trim();
};
