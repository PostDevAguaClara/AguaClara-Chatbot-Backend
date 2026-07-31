const {
    BedrockAgentRuntimeClient,
    RetrieveAndGenerateCommand,
} = require("@aws-sdk/client-bedrock-agent-runtime");

const client = new BedrockAgentRuntimeClient({});

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
    const result = await client.send(
        new RetrieveAndGenerateCommand({
            input: { text: body.prompt },
            retrieveAndGenerateConfiguration: {
                type: "KNOWLEDGE_BASE",
                knowledgeBaseConfiguration: {
                    knowledgeBaseId: process.env.KNOWLEDGEBASE_ID,
                    // modelArn: "arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0",
                    modelArn: "arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-lite-v1:0",
                    // generationConfiguration: {
                    //     promptTemplate: {
                    //         textPromptTemplate: promptTemplate
                    //     }
                    // }
                }
            }
        })
    );

    // Build responce
    const response = {
        sessionId: result.sessionId,
        output: result.output?.text ?? "",
        citations: [],
        info: "",
    };
    response.info = `Raw result: ${JSON.stringify(result, null, 2)}`;

    for (const citation of result.citations ?? []) {
        for (const reference of citation.retrievedReferences ?? []) {
            response.citations.push({
                quote: reference.content?.text ?? "",
                name: reference.metadata?.["file-name"],
                url:  reference.metadata?.["web-view-link"],
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