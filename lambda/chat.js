/**
 * chat.js
 * 
 * This is the interfacing between the Chatbot UI and the chat model.
 * 
 * It takes in a json argument which must have `lastMessage` be the current user question and
 * `conversation` be the message history in the format [{role: <"user"/"assistant">, content: "..."}].
 */
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

const MODEL_ID = "amazon.nova-lite-v1:0";

function extractExcerpt(text, quote, maxLength = 512) {
    if (!quote) { return text; }

    const index = text.toLowerCase().indexOf(quote.toLowerCase());

    if (index === -1) {
        console.warn("Could not find model-selected quote in source.");
        return text;
    }

    const start = Math.max(0, index - 128);
    const end = Math.min(text.length, start + maxLength);

    let excerpt = text.substring(start, end);

    if (start > 0) { excerpt = "..." + excerpt; }

    return excerpt;
}

exports.handler = async (event) => {
    const body = JSON.parse(event.body ?? "{}");
    console.log("User Input: ", JSON.stringify(body, null, 2));

    if (!body.lastMessage) {
        return {statusCode: 400,
            body: JSON.stringify({
                error: "Missing last message"
            })
        };
    }
    if (!body.conversation) {
        return {statusCode: 400,
            body: JSON.stringify({
                error: "Missing conversation"
            })
        };
    }

    // Retrieve relevant documents using only recent user messages
    const recentUserMessages = body.conversation
        .filter(message => message.role === "user")
        .slice(-5,-1);

    const retrievalQuery = [
        `Use the recent conversation to understand the context of the current question.
        Retrieve documentation relevant to the current question, including concepts implied by the conversation.
        \nRecent conversation:`,
        ...recentUserMessages.map(message => `User: ${message.text}`),
        `\nCurrent question: ${body.lastMessage}`,
    ].join("\n");

    const retrieved = await retrieveClient.send(
        new RetrieveCommand({
            knowledgeBaseId: process.env.KNOWLEDGEBASE_ID,
            retrievalQuery: {
                text: retrievalQuery,
            },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: 10,
                },
            },
        })
    );

    // Tag each with IDs so the model can indentify which sources they used
    const context = retrieved.retrievalResults
        .map((reference, i) => {
            return `<source id=${i + 1}> ${reference.content?.text ?? ""} <\source>`;
        })
        .join("\n\n");
    
    console.log("Context Documents: ", JSON.stringify(context, null, 2));

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
        - Consider the entire conversation when determining what the user is asking about.
        - Use the current question together with the conversation history to resolve references such as "it", "they", "this", or "that".

        If the user's message is a question about you or what the user can do:
        - Answer based on your role as an AI assistant.
        - Do not use or cite the documents unless explicitly relevant to the question.

        If the user's message is primarily conversational (for example, greetings, introductions, thanks, etc)
        - Respond naturally and briefly and in a friendly way.
        - Do not use or cite documents.
        - Do not attempt to answer using information from the documentation.
        - Optionally invite the user to ask a question about AguaClara.

        Response formatting:
        - Your response MUST be valid JSON with exactly this format:
        {
            "answer": "The natural language answer to the user.",
            "usedSources": [
                { 
                    "id": 1,
                    "quote": "A short exact quote from the source that directly supports the answer."
                }
            ]
        }
        - "answer" must contain ONLY the natural-language response that should be shown to the user.
        - "usedSources" must contain every source that is used to support your answer.
        - If no provided sources support the answer, "usedSources" must be an empty array.
        - Each "id" must exactly match the ID of a provided <source>
        - Each "quote" must be an exact, contiguous excerpt copied from the corresponding source.
        - Do NOT paraphrase, summarize, or modify quotes.
        - Each quote should be reasonably short.
        - Prefer a quote from the most relevant section of the source rather than the beginning of the source.
        - The "answer" and "usedSources" are seperate fields. Citation information belongs ONLY in "usedSources".
        - NEVER put [Source: 1], [Sources: 1, 2], (Source 1), Source 1, or any other source identifier or citation notation in the answer.
        - NEVER mention source IDs or "usedSources" in the answer.
        - Do not add any text before or after the JSON object.

        Source citation rules:
        - Include a source in "usedSources" ONLY when it supports a factual claim or is necessary for the answer.
        - Do NOT cite a source merely because it discusses the same general topic.
        - Do NOT cite a source because it was useful for understanding the question.
        - Do NOT cite a source if the answer could remain unchanged without information from that source.
        - Do NOT cite a source merely because it contains a related words or concept but does not support the answer.
        - If multiple sources are necessary, cite each source only for the claims it actually supports.
        - If multiple sources directly support different parts of the answer, cite each relevant source.
        - When the retrieved sources do not directly support a claim, do not cite them for that claim.
        - If the provided documentation does not directly support a claim, do not pretend that it does.
    `

    // Convert conversation into Bedrock Converse messages format
    const messages = body.conversation.map((message, index) => {
        if ((message.role !== "user" && message.role !== "assistant") ||
            typeof message.content !== "string" ||
            message.content.trim() === ""
        ) {
            throw new Error(
                `Invalid conversation message at index ${index}: ` +
                JSON.stringify(message)
            );
        }
        const isLastMessage = (index === body.conversation.length - 1);
        let text = message.content;
        if (isLastMessage) {
            text = `Documentation: ${context}\n\n`+
                   `User Message: ${text}`
        }
        return {
            role: message.role,
            content: [{ text }],
        };
    });
    
    const converseResult = await runtimeClient.send(
        new ConverseCommand({
            modelId: MODEL_ID,
            system: [{ text: promptInstruction }],
            messages: messages,
        })
    );

    // Build response
    const output = converseResult.output?.message?.content
        ?.map((c) => c.text ?? "")
        .join("") ?? "";

    let modelResponse;
    try {
        modelResponse = JSON.parse(output);
    } catch (e) {
        console.warn("Failed to parse model JSON:", output);
        modelResponse = {
            answer: output,
            usedSources: []
        };
    }
    console.log("Model Response: ", modelResponse);

    const response = {
        sessionId: crypto.randomUUID(),
        output: modelResponse.answer,
        citations: []
    };
    for (const source of modelResponse.usedSources) {
        const reference = retrieved.retrievalResults[source.id - 1]
        if (!reference) { continue; }
        response.citations.push({
            quote: extractExcerpt(reference.content?.text ?? "", source.quote),
            name: reference.metadata?.["file-name"],
            url: reference.metadata?.["web-view-link"],
            path: reference.metadata?.["path"],
        });
    }
    console.log("Output: ", response);

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
    };
};