const {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} = require("@aws-sdk/client-bedrock-agent-runtime");

const {
    BedrockRuntimeClient,
    ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const retrieveClient = new BedrockAgentRuntimeClient({});
const runtimeClient = new BedrockRuntimeClient({});

exports.handler = async (event) => {

    const body = JSON.parse(event.body ?? "{}");

    if (!body.prompt) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                error: "Missing prompt"
            })
        };
    }

    const retrieved = await retrieveClient.send(
        new RetrieveCommand({
            knowledgeBaseId: process.env.KNOWLEDGEBASE_ID,
            retrievalQuery: {
                text: body.prompt,
            },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: 5,
                },
            },
        })
    );

    const context = retrieved.retrievalResults
        .map((reference, i) => {
            return `<source id=${i + 1}> ${reference.content?.text ?? ""} <\source>`;
        })
        .join("\n\n");
    
    const promptTemplate = `
        You are an AguaClara documentation assistant.
        Answer the user's question using the provided documentation sources when they contain relevant information.
        If the sources do not contain enough information, say that the documentation does not provide enough information and explain what is missing.
        Do NOT answer from general knowledge.
        Do NOT reveal search steps, tool calls, reasoning, or internal actions.

        Your response MUST be valid JSON with exactly this format:

        {
            "answer": "The natural language answer to the user.",
            "usedSources": [1, 3]
        }

        The "usedSources" array must contain ONLY the source IDs that directly support your answer.
        If no provided sources support the answer, "usedSources" must be an empty array.
    `
    const converseResult = await runtimeClient.send(
        new ConverseCommand({
            modelId: "amazon.nova-lite-v1:0",
            system: [
                { text: promptTemplate },
            ],
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            text: `Documentation: ${context}
                            Question: ${body.prompt}`,
                        },
                    ],
                },
            ],
        })
    );

    // Build responce
    const output = converseResult.output?.message?.content
        ?.map((c) => c.text ?? "")
        .join("") ?? "";

    let modelResponse;
    try {
        modelResponse = JSON.parse(output);
    } catch (e) {
        console.error("Failed to parse model JSON:", output);
        modelResponse = {
            answer: output,
            usedSources: []
        };
    }

    const response = {
        sessionId: crypto.randomUUID(),
        output: modelResponse.answer,
        citations: []
    };
    for (const sourceId of modelResponse.usedSources) {
        const reference = retrieved.retrievalResults[sourceId - 1]
        if (reference) {
            response.citations.push({
                quote: reference.content?.text ?? "",
                name: reference.metadata?.["file-name"],
                url: reference.metadata?.["web-view-link"],
                path: reference.metadata?.["path"],
            });
        }
    }
    // for (const reference of retrieved.retrievalResults) {
    //     response.citations.push({
    //         quote: reference.content?.text ?? "",
    //         name: reference.metadata?.["file-name"],
    //         url: reference.metadata?.["web-view-link"],
    //         path: reference.metadata?.["path"],
    //     });
    // }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
    };
};