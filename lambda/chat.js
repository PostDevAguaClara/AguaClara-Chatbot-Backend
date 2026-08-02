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
                    numberOfResults: 10,
                },
            },
        })
    );

    const context = retrieved.retrievalResults
        .map((reference, i) => {
            return `<source id=${i + 1}> ${reference.content?.text ?? ""} <\source>`;
        })
        .join("\n\n");
    
    const promptInstruction = `
        You are an AguaClara documentation assistant.
        Your primary purpose is to help users find and understand information contained in the provided AguaClara documentation.
        You have access to a variety of AguaClara-related documents sourced from a Google Drive.
        Answer naturally and helpfully.

        If the user's message is a request for information that may be answered using documentation:
        - Use the documentation as your primary source.
        - Use the documentation to answer the user's question whenever it provides enough information, even if it does not use the exact same wording.
        - When the documentation has related information, answer the question to the best of your ability.
        - You may synthesize information from multiple sources when they collectively answer the question.
        - If the retrieved sources provide enough information to reasonably answer the user's question, answer using that information.
        - If you answer using information from the documentation, you must cite as least one document.
        - If the documents do not provide enough information to reasonably answer the question, explain that the documentation does not provide enough information.
        - Do not use or cite documents that aren't relevant or useful to the question or your answer.
        - Do not use or cite documents if the user is not requesting information.
        - Do not invent facts that are not reasonably supported by the documentation.
        - Do not reveal search steps, tool calls, reasoning, or internal actions.

        If it is a question about you or what the user can do:
        - Answer based on your role as an AI assistant.
        - Do not use or cite the documents unless explicitly relevant to the question.

        If the user's message is primarily conversational (for example, greetings, introductions, thanks, etc)
        - Respond naturally and breifly and in a friendly way.
        - Do not use or cite documents.
        - Do not attempt to answer using information from the documentation.
        - Optionally invite the user to ask a question about AguaClara.

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
                { text: promptInstruction },
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

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
    };
};