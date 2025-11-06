import { context, docIds, HTTPError } from "@budibase/backend-core"
import { ai } from "@budibase/pro"
import {
  Agent,
  AgentChat,
  AgentToolSource,
  AgentToolSourceWithTools,
  ChatAgentRequest,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateToolSourceRequest,
  DocumentType,
  FetchAgentHistoryResponse,
  FetchAgentsResponse,
  Message,
  RequiredKeys,
  Tool,
  UpdateAgentRequest,
  UpdateAgentResponse,
  UpdateToolSourceRequest,
  UserCtx,
  type AgentStreamEvent,
  type AgentOutputItem,
  type AgentOutputItemPatch,
  type AgentResponseStartedEvent,
  type AgentOutputTextDeltaEvent,
  type AgentOutputTextCompletedEvent,
  type AgentOutputItemCreatedEvent,
  type AgentOutputItemUpdatedEvent,
  type AgentToolCallStartedEvent,
  type AgentToolCallCompletedEvent,
  type AgentRunCompletedEvent,
  type AgentRunErrorEvent,
  type AgentRunSavedEvent,
} from "@budibase/types"
import { createToolSource as createToolSourceInstance } from "../../../ai/tools/base"
import sdk from "../../../sdk"
import { randomUUID } from "crypto"

function addDebugInformation(messages: Message[]) {
  const processedMessages = [...messages]
  for (let i = 0; i < processedMessages.length; i++) {
    const message = processedMessages[i]
    if (message.role === "assistant" && message.tool_calls?.length) {
      // For each tool call, add debug information to the assistant message content
      let toolDebugInfo = "\n\n**Tool Calls:**\n"

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function" || !toolCall.function) {
          console.warn(
            `[OPENAI TOOL WARN] Unsupported tool call type: ${toolCall.type}`
          )
          continue
        }

        let toolParams = "{}"
        try {
          // Try to parse and prettify the JSON arguments
          toolParams = JSON.stringify(
            JSON.parse(toolCall.function.arguments),
            null,
            2
          )
        } catch (e) {
          // If not valid JSON, use as is
          toolParams = toolCall.function.arguments
        }

        toolDebugInfo += `\n**Tool:** ${toolCall.function.name}\n**Parameters:**\n\`\`\`json\n${toolParams}\n\`\`\`\n`
      }

      // Append tool debug info to the message content
      if (message.content) {
        message.content += toolDebugInfo
      } else {
        message.content = toolDebugInfo
      }
    }
  }
  return processedMessages
}

export async function agentChatStream(ctx: UserCtx<ChatAgentRequest, void>) {
  const model = await sdk.aiConfigs.getLLMOrThrow()
  const chat = ctx.request.body
  const db = context.getWorkspaceDB()
  const agentId = chat.agentId

  // Set SSE headers and status
  ctx.status = 200
  ctx.set("Content-Type", "text/event-stream")
  ctx.set("Cache-Control", "no-cache")
  ctx.set("Connection", "keep-alive")
  ctx.set("Access-Control-Allow-Origin", "*")
  ctx.set("Access-Control-Allow-Headers", "Cache-Control")

  // Disable buffering for better streaming
  ctx.res.setHeader("X-Accel-Buffering", "no") // Nginx
  ctx.res.setHeader("Transfer-Encoding", "chunked")

  const agent = await sdk.ai.agents.getOrThrow(agentId)

  const runId = randomUUID()
  const responseId = randomUUID()
  let sequence = 0
  let activeTextItemId: string | undefined
  let accumulatedText = ""

  const emitEventInternal = (
    event: Omit<AgentStreamEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => {
    const enriched = {
      ...event,
      eventId: randomUUID(),
      runId,
      sequence: sequence++,
      timestamp: new Date().toISOString(),
    } as AgentStreamEvent
    ctx.res.write(`data: ${JSON.stringify({ event: enriched })}\n\n`)
  }

  const emitResponseStarted = (
    event: Omit<AgentResponseStartedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitOutputTextDelta = (
    event: Omit<AgentOutputTextDeltaEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitOutputTextCompleted = (
    event: Omit<AgentOutputTextCompletedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitOutputItemCreated = (
    event: Omit<AgentOutputItemCreatedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitOutputItemUpdated = (
    event: Omit<AgentOutputItemUpdatedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitToolCallStarted = (
    event: Omit<AgentToolCallStartedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitToolCallCompleted = (
    event: Omit<AgentToolCallCompletedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitRunCompleted = (
    event: Omit<AgentRunCompletedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitRunError = (
    event: Omit<AgentRunErrorEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const emitRunSaved = (
    event: Omit<AgentRunSavedEvent, "eventId" | "runId" | "sequence" | "timestamp">
  ) => emitEventInternal(event)

  const ensureTextItem = () => {
    if (!activeTextItemId) {
      activeTextItemId = randomUUID()
      const item: AgentOutputItem = {
        id: activeTextItemId,
        type: "text",
        role: "assistant",
        text: "",
      }
      emitOutputItemCreated({
        type: "response.output_item.created",
        responseId,
        item,
      })
    }
    return activeTextItemId
  }

  let prompt = new ai.LLMRequest()
    .addSystemMessage(ai.agentSystemPrompt(ctx.user))
    .addMessages(chat.messages)

  let toolGuidelines = ""

  for (const toolSource of agent.allowedTools || []) {
    const toolSourceInstance = createToolSourceInstance(
      toolSource as AgentToolSource
    )

    if (!toolSourceInstance) {
      continue
    }

    const guidelines = toolSourceInstance.getGuidelines()
    if (guidelines) {
      toolGuidelines += `\n\nWhen using ${toolSourceInstance.getName()} tools, ensure you follow these guidelines:\n${guidelines}`
    }

    const toolsToAdd = toolSourceInstance.getEnabledTools()

    if (toolsToAdd.length > 0) {
      prompt = prompt.addTools(toolsToAdd)
    }
  }

  // Append tool guidelines to the system prompt if any exist
  if (toolGuidelines) {
    prompt = prompt.addSystemMessage(toolGuidelines)
  }

  emitResponseStarted({
    type: "response.started",
    responseId,
    metadata: {
      agentId,
    },
  })

  try {
    let finalMessages: Message[] = []
    let totalTokens = 0

    for await (const chunk of model.chatStream(prompt)) {
      if (chunk.type === "content" && chunk.content) {
        const itemId = ensureTextItem()
        accumulatedText += chunk.content
        emitOutputTextDelta({
          type: "response.output_text.delta",
          responseId,
          itemId,
          delta: chunk.content,
        })
      } else if (chunk.type === "tool_call_start" && chunk.toolCall) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(chunk.toolCall.arguments || "{}")
        } catch {
          parsedArgs = {
            raw: chunk.toolCall.arguments,
          }
        }
        emitToolCallStarted({
          type: "response.tool_call.started",
          responseId,
          callId: chunk.toolCall.id,
          name: chunk.toolCall.name,
          arguments: parsedArgs,
        })
      } else if (chunk.type === "tool_call_result" && chunk.toolResult) {
        let parsedResult: Record<string, unknown> | string | undefined =
          chunk.toolResult.result
        if (chunk.toolResult.result) {
          try {
            const parsedJson = JSON.parse(chunk.toolResult.result)
            if (parsedJson && typeof parsedJson === "object") {
              parsedResult = parsedJson
            }
          } catch {
            // ignore parsing failure and fall back to string result
          }
        }

        emitToolCallCompleted({
          type: "response.tool_call.completed",
          responseId,
          callId: chunk.toolResult.id,
          status: chunk.toolResult.error ? "error" : "success",
          result:
            chunk.toolResult.error || parsedResult === undefined
              ? undefined
              : parsedResult,
          error: chunk.toolResult.error
            ? {
                message: chunk.toolResult.error,
              }
            : undefined,
        })

        if (
          !chunk.toolResult.error &&
          parsedResult &&
          typeof parsedResult === "object"
        ) {
          const parsedObject = parsedResult as Record<string, unknown>
          const maybeMessage = parsedObject.message
          if (typeof maybeMessage === "string" && maybeMessage.length) {
            const itemId = randomUUID()
            emitOutputItemCreated({
              type: "response.output_item.created",
              responseId,
              item: {
                id: itemId,
                type: "text",
                role: "assistant",
                text: maybeMessage,
                metadata: {
                  sourceToolCallId: chunk.toolResult.id,
                },
              },
            })
            emitOutputTextCompleted({
              type: "response.output_text.completed",
              responseId,
              itemId,
              text: maybeMessage,
            })
          }

          const maybeComponent = parsedObject.component
          if (maybeComponent && typeof maybeComponent === "object") {
            const componentId =
              (maybeComponent as { componentId?: string }).componentId ||
              randomUUID()
            emitOutputItemCreated({
              type: "response.output_item.created",
              responseId,
              item: {
                id: componentId,
                type: "component",
                role: "assistant",
                component: maybeComponent as any,
                metadata: {
                  sourceToolCallId: chunk.toolResult.id,
                },
              },
            })
          }

          if (
            parsedObject.removeComponentMessage &&
            parsedObject.componentId &&
            typeof parsedObject.componentId === "string"
          ) {
            const patch: AgentOutputItemPatch = {
              state: "hidden",
              metadata: {
                reason: "submitted",
                sourceToolCallId: chunk.toolResult.id,
              },
            }
            const successMessage =
              typeof parsedObject.message === "string"
                ? parsedObject.message
                : undefined
            if (successMessage && successMessage.length) {
              patch.replaceWith = {
                id: `${parsedObject.componentId}-result-${randomUUID()}`,
                type: "text",
                role: "assistant",
                text: successMessage,
                metadata: {
                  sourceToolCallId: chunk.toolResult.id,
                },
              }
            }
            emitOutputItemUpdated({
              type: "response.output_item.updated",
              responseId,
              itemId: parsedObject.componentId,
              patch,
            })
          }
        }
      } else if (chunk.type === "error") {
        emitRunError({
          type: "response.error",
          responseId,
          error: {
            message: chunk.content || "An error occurred",
            retryable: false,
          },
        })
        ctx.res.end()
        return
      } else if (chunk.type === "done") {
        finalMessages = chunk.messages || []
        totalTokens = chunk.tokensUsed || 0
        if (activeTextItemId) {
          emitOutputTextCompleted({
            type: "response.output_text.completed",
            responseId,
            itemId: activeTextItemId,
            text: accumulatedText,
          })
        }
        emitRunCompleted({
          type: "response.completed",
          responseId,
          tokensUsed: totalTokens,
        })
        break
      }
    }

    // Save chat to database after streaming is complete
    if (finalMessages.length > 0) {
      if (!chat._id) {
        chat._id = docIds.generateAgentChatID()
      }
      const chatId = chat._id as string

      if (!chat.title || chat.title === "") {
        const titlePrompt = new ai.LLMRequest()
          .addSystemMessage(ai.agentHistoryTitleSystemPrompt())
          .addMessages(finalMessages)
        const { message } = await model.prompt(titlePrompt)
        chat.title = message
      }

      const newChat: AgentChat = {
        _id: chatId,
        _rev: chat._rev,
        agentId,
        title: chat.title,
        messages: addDebugInformation(finalMessages),
      }

      const { rev } = await db.put(newChat)

      // Send final chat info
      const savedEvent: Omit<
        AgentRunSavedEvent,
        "eventId" | "runId" | "sequence" | "timestamp"
      > = {
        type: "response.saved",
        responseId,
        chatId,
        metadata: {
          tokensUsed: totalTokens,
        },
      }
      if (rev) {
        savedEvent.revision = rev
      }
      emitRunSaved(savedEvent)
    }

    ctx.res.end()
  } catch (error: any) {
    emitRunError({
      type: "response.error",
      responseId,
      error: {
        message: error.message,
        retryable: false,
      },
    })
    ctx.res.end()
  }
}

export async function remove(ctx: UserCtx<void, void>) {
  const db = context.getWorkspaceDB()

  const chatId = ctx.params.chatId
  if (!chatId) {
    throw new HTTPError("chatId is required", 400)
  }

  const chat = await db.tryGet<AgentChat>(chatId)
  if (!chat) {
    throw new HTTPError("chat not found", 404)
  }

  await db.remove(chat)
  ctx.status = 201
}

export async function fetchHistory(
  ctx: UserCtx<void, FetchAgentHistoryResponse>
) {
  const db = context.getWorkspaceDB()
  const agentId = ctx.params.agentId
  await sdk.ai.agents.getOrThrow(agentId)

  const allChats = await db.allDocs<AgentChat>(
    docIds.getDocParams(DocumentType.AGENT_CHAT, undefined, {
      include_docs: true,
    })
  )

  ctx.body = allChats.rows
    .map(row => row.doc!)
    .filter(chat => chat.agentId === agentId)
    .sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return timeB - timeA // Newest first
    })
}

export async function fetchToolSources(
  ctx: UserCtx<void, AgentToolSourceWithTools[], { agentId: string }>
) {
  const agentId = ctx.params.agentId

  if (!agentId) {
    throw new HTTPError("agentId is required", 400)
  }

  const agent = await sdk.ai.agents.getOrThrow(agentId)

  ctx.body = (agent.allowedTools || []).map(toolSource => {
    const toolSourceInstance = createToolSourceInstance(toolSource)

    const tools: Tool[] = toolSourceInstance
      ? toolSourceInstance.getTools()
      : []

    return {
      ...toolSource,
      tools,
    }
  })
}

export async function createToolSource(
  ctx: UserCtx<CreateToolSourceRequest, { created: true }>
) {
  const toolSourceRequest = ctx.request.body

  if (!toolSourceRequest.agentId) {
    throw new HTTPError("agentId is required", 400)
  }

  const agent = await sdk.ai.agents.getOrThrow(toolSourceRequest.agentId)

  // Generate a unique ID for the tool source
  const toolSourceId = docIds.generateAgentToolSourceID()

  // Remove agentId from tool source as it's not part of the tool source structure
  const { agentId: _, ...toolSourceData } = toolSourceRequest

  const toolSource: AgentToolSource = {
    ...toolSourceData,
    id: toolSourceId,
  } as AgentToolSource

  // Add tool source to agent's allowedTools
  const updatedAgent: Agent = {
    ...agent,
    allowedTools: [...(agent.allowedTools || []), toolSource],
  }

  await sdk.ai.agents.update(updatedAgent)

  ctx.body = { created: true }
  ctx.status = 201
}

export async function updateToolSource(
  ctx: UserCtx<UpdateToolSourceRequest, AgentToolSource>
) {
  const toolSourceRequest = ctx.request.body

  if (!toolSourceRequest.id) {
    throw new HTTPError("id field missing", 400)
  }

  if (!toolSourceRequest.agentId) {
    throw new HTTPError("agentId is required", 400)
  }

  const agent = await sdk.ai.agents.getOrThrow(toolSourceRequest.agentId)

  // Remove agentId from tool source as it's not part of the tool source structure
  const { agentId: _, ...toolSourceData } = toolSourceRequest

  // Find and update the tool source in allowedTools
  const updatedAllowedTools = (agent.allowedTools || []).map(ts => {
    if ((ts as any).id === toolSourceRequest.id) {
      return {
        ...toolSourceData,
        id: toolSourceRequest.id,
      } as AgentToolSource
    }
    return ts
  })

  const updatedAgent: Agent = {
    ...agent,
    allowedTools: updatedAllowedTools,
  }

  await sdk.ai.agents.update(updatedAgent)

  // Return the updated tool source
  const updatedToolSource = updatedAllowedTools.find(
    ts => (ts as any).id === toolSourceRequest.id
  ) as AgentToolSource

  ctx.body = updatedToolSource
  ctx.status = 200
}

export async function deleteToolSource(ctx: UserCtx<void, { deleted: true }>) {
  const toolSourceId = ctx.params.toolSourceId

  // Find agent that contains this tool source
  const agents = await sdk.ai.agents.fetch()
  const agentWithToolSource = agents.find(agent =>
    (agent.allowedTools || []).some(ts => (ts as any).id === toolSourceId)
  )

  if (!agentWithToolSource) {
    throw new HTTPError("Tool source not found", 404)
  }

  // Remove tool source from agent's allowedTools
  const updatedAgent: Agent = {
    ...agentWithToolSource,
    allowedTools: (agentWithToolSource.allowedTools || []).filter(
      ts => (ts as any).id !== toolSourceId
    ),
  }

  await sdk.ai.agents.update(updatedAgent)

  ctx.body = { deleted: true }
  ctx.status = 200
}

export async function fetchAgents(ctx: UserCtx<void, FetchAgentsResponse>) {
  const agents = await sdk.ai.agents.fetch()
  ctx.body = { agents }
}

export async function createAgent(
  ctx: UserCtx<CreateAgentRequest, CreateAgentResponse>
) {
  const body = ctx.request.body

  const createRequest: RequiredKeys<CreateAgentRequest> = {
    name: body.name,
    description: body.description,
    aiconfig: body.aiconfig,
    promptInstructions: body.promptInstructions,
    allowedTools: body.allowedTools || [],
    _deleted: false,
  }

  const agent = await sdk.ai.agents.create(createRequest)

  ctx.body = agent
  ctx.status = 201
}

export async function updateAgent(
  ctx: UserCtx<UpdateAgentRequest, UpdateAgentResponse>
) {
  const body = ctx.request.body

  const updateRequest: RequiredKeys<UpdateAgentRequest> = {
    _id: body._id,
    _rev: body._rev,
    name: body.name,
    description: body.description,
    aiconfig: body.aiconfig,
    promptInstructions: body.promptInstructions,
    allowedTools: body.allowedTools,
    _deleted: false,
  }

  const agent = await sdk.ai.agents.update(updateRequest)

  ctx.body = agent
  ctx.status = 200
}

export async function deleteAgent(
  ctx: UserCtx<void, { deleted: true }, { agentId: string }>
) {
  const agentId = ctx.params.agentId
  await sdk.ai.agents.remove(agentId ?? "")
  ctx.body = { deleted: true }
  ctx.status = 200
}
