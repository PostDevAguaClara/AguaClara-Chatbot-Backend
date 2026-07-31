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
    const promptTemplate = `
        <instructions>
        You are an AguaClara documentation assistant.
        Answer the user's questions using only the retrived doucments.
        Do NOT reveal search steps, tool calls, reasoning, or internal actions.
        Do NOT output "Actions:", "Observation:", "Response:", "Passage:", or similar labels.
        Responce only with the final answer in natural language.
        </instructions>

        <database>
        $search_results$
        </database>

        <question>
        $query$
        </question>
    `
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
            return `Source ${i + 1} ${reference.content?.text ?? ""}`;
        })
        .join("\n\n------------------------\n\n");
    
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

    const response = {
        sessionId: crypto.randomUUID(),
        output: output,
        citations: []
    };

    
    for (const reference of retrieved.retrievalResults) {
        response.citations.push({
            quote: reference.content?.text ?? "",
            name: reference.metadata?.["file-name"],
            url: reference.metadata?.["web-view-link"],
            path: reference.metadata?.["path"],
        });
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
    };
};