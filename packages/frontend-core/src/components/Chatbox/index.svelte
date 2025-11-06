<script lang="ts">
import { MarkdownViewer, notifications } from "@budibase/bbui"
import { createAPIClient } from "@budibase/frontend-core"
import type {
  AgentChat,
  AgentStreamEvent,
    AssistantMessage,
    ComponentPayload,
    SystemMessage,
    UserMessage,
  } from "@budibase/types"
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte"
  import BBAI from "../../icons/BBAI.svelte"
  import Component from "./Component"

  export let API = createAPIClient()

  export let workspaceId: string
  export let chat: AgentChat
  export let loading: boolean = false

  const dispatch = createEventDispatcher<{ chatSaved: { chatId: string } }>()

  let inputValue = ""
  let chatAreaElement: HTMLDivElement
  let observer: MutationObserver
  let textareaElement: HTMLTextAreaElement
  let componentLoading = new Set<string>()
  type AssistantTextSegment = { id: string; type: "text"; content: string }
  type AssistantComponentSegment = {
    id: string
    type: "component"
    component: ComponentPayload
    hidden?: boolean
  }
  type AssistantSegment = AssistantTextSegment | AssistantComponentSegment
  const toolResultComponentPlaceholderRegex =
    /\{\{toolResult:component:([^}]+)\}\}/g

  interface ResponseState {
    responseId: string
    messageIndex: number
    segments: AssistantSegment[]
  }

  const responseStates = new Map<string, ResponseState>()
  const itemToResponse = new Map<
    string,
    { responseId: string; segmentIndex: number }
  >()
  const messageResponseMap = new Map<number, string>()
  const toolCallComponentMap = new Map<string, string>()
  let responseStatesVersion = 0
  let activeResponseId: string | null = null
  let lastHydratedKey: string | null = null

  const setComponentLoading = (componentId: string, isLoading: boolean) => {
    if (!componentId) {
      return
    }
    const next = new Set(componentLoading)
    if (isLoading) {
      next.add(componentId)
    } else {
      next.delete(componentId)
    }
    componentLoading = next
  }

  const clearComponentLoading = (componentId?: string) => {
    if (!componentId) {
      return
    }
    setComponentLoading(componentId, false)
  }
 
  const reindexResponseSegments = (responseId: string) => {
    const state = responseStates.get(responseId)
    if (!state) {
      return
    }
    state.segments.forEach((segment, index) => {
      itemToResponse.set(segment.id, {
        responseId,
        segmentIndex: index,
      })
    })
  }

  const locateSegment = (itemId: string) => {
    const existing = itemToResponse.get(itemId)
    if (existing) {
      return existing
    }
    for (const state of responseStates.values()) {
      const segmentIndex = state.segments.findIndex(
        segment => segment.id === itemId
      )
      if (segmentIndex !== -1) {
        const mapping = {
          responseId: state.responseId,
          segmentIndex,
        }
        itemToResponse.set(itemId, mapping)
        return mapping
      }
    }
    return undefined
  }

  const rehydrateFromChatHistory = () => {
    if (!chat?.messages?.length) {
      return
    }
    const toolResults = new Map<string, any>()
    for (const message of chat.messages) {
      if (message.role === "tool" && message.tool_call_id) {
        const content = (() => {
          const raw = message.content
          if (typeof raw === "string") {
            return raw
          }
          if (Array.isArray(raw)) {
            const items = raw as Array<unknown>
            return items
              .map((part: unknown) => {
                if (typeof part === "string") {
                  return part
                }
                if (
                  part &&
                  typeof (part as { text?: unknown }).text === "string"
                ) {
                  return (part as { text?: string }).text ?? ""
                }
                return ""
              })
              .join("")
          }
          return ""
        })()
        try {
          const parsed = JSON.parse(content || "{}")
          toolResults.set(message.tool_call_id, parsed)
        } catch {
          // ignore malformed tool messages
        }
      }
    }

    responseStates.clear()
    itemToResponse.clear()
    messageResponseMap.clear()
    componentLoading = new Set<string>()

    chat.messages.forEach((message, index) => {
      if (message.role !== "assistant") {
        return
      }
      const content =
        typeof message.content === "string" ? message.content : ""
      if (!content) {
        return
      }

      const segments: AssistantSegment[] = []
      toolResultComponentPlaceholderRegex.lastIndex = 0
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = toolResultComponentPlaceholderRegex.exec(content))) {
        const matchIndex = match.index ?? 0
        const textBefore = content.slice(lastIndex, matchIndex).trim()
        if (textBefore.length) {
          segments.push({
            id: `history-${index}-text-${segments.length}`,
            type: "text",
            content: textBefore,
          })
        }
        const toolId = match[1]?.trim()
        const result = toolId ? toolResults.get(toolId) : undefined
        if (
          result &&
          result.component &&
          !result.removeComponentMessage &&
          typeof result.component === "object"
        ) {
          const componentId =
            (result.component.componentId as string | undefined) ||
            toolId ||
            `history-${index}-component-${segments.length}`
          segments.push({
            id: componentId,
            type: "component",
            component: result.component as ComponentPayload,
          })
        } else if (
          result &&
          result.removeComponentMessage &&
          typeof result.message === "string" &&
          result.message.length
        ) {
          segments.push({
            id: `history-${index}-text-${segments.length}`,
            type: "text",
            content: result.message,
          })
        }

        lastIndex = matchIndex + match[0].length
      }

      const remaining = content.slice(lastIndex).trim()
      if (remaining.length) {
        segments.push({
          id: `history-${index}-text-${segments.length}`,
          type: "text",
          content: remaining,
        })
      }

      if (!segments.length) {
        return
      }

      const responseId = `history-${index}`
      responseStates.set(responseId, {
        responseId,
        messageIndex: index,
        segments,
      })
      messageResponseMap.set(index, responseId)
      segments.forEach((segment, segmentIndex) => {
        itemToResponse.set(segment.id, {
          responseId,
          segmentIndex,
        })
      })
    })

    responseStatesVersion += 1
  }

  $: if (chat.messages.length) {
    scrollToBottom()
  }

  $: if (responseStatesVersion) {
    scrollToBottom()
  }

  $: if (
    !activeResponseId &&
    chat?.messages?.length &&
    chat.messages.length > 0
  ) {
    const key = `${chat._rev ?? "no-rev"}:${chat.messages.length}`
    if (key !== lastHydratedKey) {
      rehydrateFromChatHistory()
      lastHydratedKey = key
    }
  }

  async function scrollToBottom() {
    await tick()
    if (chatAreaElement) {
      chatAreaElement.scrollTop = chatAreaElement.scrollHeight
    }
  }

  async function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      await prompt()
    }
  }

  async function prompt(message?: string, role: "system" | "user" = "user") {
    if (!chat) {
      chat = { title: "", messages: [], agentId: "" }
    }

    const userMessage: UserMessage | SystemMessage = {
      role,
      content: message ?? inputValue,
    }

    let updatedChat: AgentChat = {
      ...chat,
      messages: [...chat.messages, userMessage],
    }

    chat = updatedChat

    await scrollToBottom()

    inputValue = ""
    loading = true

    const pushAssistantMessage = (responseId: string) => {
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: "",
      }
      const messages = [...updatedChat.messages, assistantMessage]
      const messageIndex = messages.length - 1
      messageResponseMap.set(messageIndex, responseId)
      updatedChat = { ...updatedChat, messages }
      chat = { ...chat, messages }
      return messageIndex
    }

    const refreshAssistantMessageContent = (responseId: string) => {
      const state = responseStates.get(responseId)
      if (!state) {
        return
    }
    const existing = updatedChat.messages[state.messageIndex] as
      | AssistantMessage
      | undefined
    if (!existing) {
      return
    }
    const parts: string[] = []
    for (const segment of state.segments) {
      if (segment.type === "component") {
        if (!segment.hidden) {
          parts.push(`{{toolResult:component:${segment.id}}}`)
        }
      } else if (segment.content.trim().length) {
        parts.push(segment.content.trim())
      }
    }
    const textContent = parts.join("\n\n").trim()
    const updatedMessage: AssistantMessage = {
      ...existing,
      content: textContent,
    }
    const messages = [...updatedChat.messages]
      messages[state.messageIndex] = updatedMessage
      updatedChat = { ...updatedChat, messages }
      chat = { ...chat, messages }
      messageResponseMap.set(state.messageIndex, responseId)
    }

    const getOrCreateResponseState = (responseId: string) => {
      let state = responseStates.get(responseId)
      if (!state) {
        const messageIndex = pushAssistantMessage(responseId)
        state = {
          responseId,
          messageIndex,
          segments: [],
        }
        responseStates.set(responseId, state)
        responseStatesVersion += 1
      } else {
        messageResponseMap.set(state.messageIndex, responseId)
      }
      return state
    }

  const replaceSegment = (
    responseId: string,
    segmentIndex: number,
    segment: AssistantSegment
  ) => {
      const state = responseStates.get(responseId)
    if (!state) {
      return
    }
    const segments = [...state.segments]
    segments[segmentIndex] = segment
    responseStates.set(responseId, {
      ...state,
      segments,
    })
    reindexResponseSegments(responseId)
    responseStatesVersion += 1
    refreshAssistantMessageContent(responseId)
  }

  const appendSegment = (responseId: string, segment: AssistantSegment) => {
    const state = getOrCreateResponseState(responseId)
    const segments = [...state.segments, segment]
    responseStates.set(responseId, {
      ...state,
      segments,
    })
    reindexResponseSegments(responseId)
    responseStatesVersion += 1
    refreshAssistantMessageContent(responseId)
  }

    const updateTextSegment = (
      itemId: string,
      updater: (segment: AssistantTextSegment) => AssistantTextSegment
    ) => {
      const mapping = itemToResponse.get(itemId)
      if (!mapping) {
        return
      }
      const state = responseStates.get(mapping.responseId)
      if (!state) {
        return
      }
      const current = state.segments[mapping.segmentIndex]
      if (!current || current.type !== "text") {
        return
      }
      const updatedSegment = updater(current)
      replaceSegment(mapping.responseId, mapping.segmentIndex, updatedSegment)
    }

    try {
      await API.agentChatStream(
        updatedChat,
        workspaceId,
        (event: AgentStreamEvent) => {
          switch (event.type) {
            case "response.started": {
              activeResponseId = event.responseId
              getOrCreateResponseState(event.responseId)
              scrollToBottom()
              break
            }
            case "response.output_item.created": {
              const responseId = event.responseId || activeResponseId
              if (!responseId) {
                break
              }
              if (event.item.type === "text") {
                appendSegment(responseId, {
                  id: event.item.id,
                  type: "text",
                  content: event.item.text || "",
                })
              } else if (event.item.type === "component") {
                appendSegment(responseId, {
                  id: event.item.id,
                  type: "component",
                  component: event.item.component,
                })
              }
              break
            }
            case "response.output_text.delta": {
              const responseId = event.responseId || activeResponseId
              if (!responseId) {
                break
              }
              updateTextSegment(event.itemId, segment => ({
                ...segment,
                content: `${segment.content}${event.delta || ""}`,
              }))
              break
            }
            case "response.output_text.completed": {
              updateTextSegment(event.itemId, segment => ({
                ...segment,
                content: event.text ?? segment.content,
              }))
              break
            }
            case "response.output_item.updated": {
              const mapping = locateSegment(event.itemId)
              if (!mapping) {
                break
              }
              const state = responseStates.get(mapping.responseId)
              if (!state) {
                break
              }
              const current = state.segments[mapping.segmentIndex]
              if (!current) {
                break
              }
              if (
                event.patch.state === "hidden" &&
                !event.patch.replaceWith
              ) {
                const segments = [...state.segments]
                segments.splice(mapping.segmentIndex, 1)
                responseStates.set(mapping.responseId, {
                  ...state,
                  segments,
                })
                itemToResponse.delete(event.itemId)
                reindexResponseSegments(mapping.responseId)
                responseStatesVersion += 1
                refreshAssistantMessageContent(mapping.responseId)
                if (current.type === "component") {
                  clearComponentLoading(current.id)
                }
              } else if (event.patch.replaceWith) {
                const replacement: AssistantSegment =
                  event.patch.replaceWith.type === "text"
                    ? ({
                        id: event.patch.replaceWith.id,
                        type: "text",
                        content: event.patch.replaceWith.text || "",
                      } as AssistantTextSegment)
                    : ({
                        id: event.patch.replaceWith.id,
                        type: "component",
                        component: event.patch.replaceWith
                          .component as ComponentPayload,
                      } as AssistantComponentSegment)
                replaceSegment(
                  mapping.responseId,
                  mapping.segmentIndex,
                  replacement
                )
                itemToResponse.delete(event.itemId)
                clearComponentLoading(event.itemId)
              } else if (current.type === "component") {
                const updatedSegment: AssistantComponentSegment = {
                  ...current,
                  hidden:
                    event.patch.state === "hidden" ? true : current.hidden,
                }
                if (event.patch.state === "hidden") {
                  clearComponentLoading(current.id)
                }
                replaceSegment(
                  mapping.responseId,
                  mapping.segmentIndex,
                  updatedSegment
                )
              }
              break
            }
            case "response.tool_call.started": {
              const componentId = (() => {
                const args = event.arguments || {}
                if (typeof args.componentId === "string") {
                  return args.componentId
                }
                if (typeof args.componentID === "string") {
                  return args.componentID
                }
                return undefined
              })()
              if (componentId) {
                setComponentLoading(componentId, true)
                toolCallComponentMap.set(event.callId, componentId)
              }
              break
            }
            case "response.tool_call.completed": {
              const componentId = toolCallComponentMap.get(event.callId)
              if (componentId) {
                clearComponentLoading(componentId)
                toolCallComponentMap.delete(event.callId)
              }
              if (event.status === "error" && event.error?.message) {
                notifications.error(event.error.message)
              }
              break
            }
            case "response.completed": {
              activeResponseId = null
              loading = false
              scrollToBottom()
              break
            }
            case "response.error": {
              activeResponseId = null
              loading = false
              if (event.error?.message) {
                notifications.error(event.error.message)
              }
              break
            }
            case "response.saved": {
              chat = {
                ...chat,
                _id: event.chatId,
                _rev: event.revision ?? chat._rev,
              }
              updatedChat = {
                ...updatedChat,
                _id: event.chatId,
                _rev: event.revision ?? updatedChat._rev,
              }
              dispatch("chatSaved", { chatId: event.chatId })
              break
            }
            default:
              break
          }
        },
        error => {
          console.error("Streaming error:", error)
          notifications.error(error.message)
          loading = false
          activeResponseId = null
        }
      )
    } catch (err: any) {
      console.error(err)
      notifications.error(err.message)
      loading = false
      activeResponseId = null
    }

    // Return focus to textarea after the response
    await tick()
    if (textareaElement) {
      textareaElement.focus()
    }
  }

  const getAssistantSegments = (
    message: AssistantMessage,
    index: number
  ): AssistantSegment[] => {
    responseStatesVersion
    const responseId = messageResponseMap.get(index)
    if (responseId) {
      const state = responseStates.get(responseId)
      if (state) {
        return state.segments.filter(segment => {
          if (segment.type === "component") {
            return !segment.hidden
          }
          return segment.content.trim().length > 0
        })
      }
    }

    const content =
      typeof message.content === "string" ? message.content.trim() : ""
    if (content.length) {
      return [
        {
          id: `${index}-text`,
          type: "text",
          content,
        },
      ]
    }

    return []
  }

  async function submitComponent(
    event: CustomEvent<{
      componentId: string
      tableId: string
      values: Record<string, unknown>
    }>
  ) {
    const { componentId, tableId, values } = event.detail
    setComponentLoading(componentId, true)
    const data = {
      type: "FORM_SUBMISSION",
      componentId,
      values,
      tableId,
    }
    await prompt(JSON.stringify(data), "system")
  }

  onMount(async () => {
    responseStates.clear()
    itemToResponse.clear()
    messageResponseMap.clear()
    toolCallComponentMap.clear()
    componentLoading = new Set<string>()
    responseStatesVersion = 0
    activeResponseId = null
     lastHydratedKey = null
    chat = { title: "", messages: [], agentId: chat.agentId }

    // Ensure we always autoscroll to reveal new messages
    observer = new MutationObserver(async () => {
      await tick()
      if (chatAreaElement) {
        chatAreaElement.scrollTop = chatAreaElement.scrollHeight
      }
    })

    if (chatAreaElement) {
      observer.observe(chatAreaElement, {
        childList: true,
        subtree: true,
        attributes: true,
      })
    }

    await tick()
    if (textareaElement) {
      textareaElement.focus()
    }
  })

  onDestroy(() => {
    observer.disconnect()
  })
</script>

<div class="chat-area" bind:this={chatAreaElement}>
  <div class="chatbox">
    {#each chat.messages as message, index (index)}
      {#if message.role === "user"}
        <div class="message user">
          <MarkdownViewer
            value={typeof message.content === "string"
              ? message.content
              : message.content.length > 0
                ? message.content
                    .map(part =>
                      part.type === "text"
                        ? part.text
                        : `${part.type} content not supported`
                    )
                    .join("")
                : "[Empty message]"}
          />
        </div>
      {:else if message.role === "assistant"}
        <div class="message assistant">
          {#each getAssistantSegments(message, index) as segment, segmentIndex (`${index}-${segmentIndex}`)}
            {#if segment.type === "text"}
              <MarkdownViewer value={segment.content} />
            {:else}
              <div
                class="component-message"
                class:component-message--loading={componentLoading.has(
                  segment.id
                )}
              >
                <Component
                  data={segment.component}
                  on:submit={submitComponent}
                />
                {#if componentLoading.has(segment.id)}
                  <div class="component-message__overlay">
                    <div class="component-message__status">
                      <span class="component-message__status-dot" />
                      <span>Submitting…</span>
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/each}
    {#if loading}
      <div class="message system">
        <BBAI size="48px" animate />
      </div>
    {/if}
  </div>

  <div class="input-wrapper">
    <textarea
      bind:value={inputValue}
      bind:this={textareaElement}
      class="input spectrum-Textfield-input"
      on:keydown={handleKeyDown}
      placeholder="Ask anything"
      disabled={loading}
    />
  </div>
</div>

<style>
  .chat-area {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    height: 0;
  }
  .chatbox {
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 600px;
    margin: 0 auto;
    flex: 1 1 auto;
    padding: 48px 0 24px 0;
  }

  .message {
    display: flex;
    flex-direction: column;
    max-width: 80%;
    padding: var(--spacing-l);
    border-radius: 20px;
    font-size: 16px;
    color: var(--spectrum-global-color-gray-900);
  }

  .message.user {
    align-self: flex-end;
    background-color: var(--grey-3);
  }

  .message.assistant {
    align-self: flex-start;
    background-color: var(--grey-1);
    border: 1px solid var(--grey-3);
  }

  .message.system {
    align-self: flex-start;
    background: none;
    padding-left: 0;
  }

  .input-wrapper {
    bottom: 0;
    width: 600px;
    margin: 0 auto;
    background: var(--background-alt);
    padding-bottom: 32px;
    display: flex;
    flex-direction: column;
  }

  .input {
    width: 100%;
    height: 100px;
    top: 0;
    resize: none;
    padding: 20px;
    font-size: 16px;
    background-color: var(--grey-3);
    color: var(--grey-9);
    border-radius: 16px;
    border: none;
    outline: none;
    min-height: 100px;
    margin-bottom: 8px;
  }

  .input::placeholder {
    color: var(--spectrum-global-color-gray-600);
  }

  :global(.assistant strong) {
    color: var(--spectrum-global-color-static-seafoam-700);
  }

  :global(.assistant h3) {
    margin-top: var(--spacing-m);
    color: var(--spectrum-global-color-static-seafoam-700);
  }

  :global(.assistant pre) {
    background-color: var(--grey-2);
    border: 1px solid var(--grey-3);
    border-radius: 4px;
  }

  .component-message {
    position: relative;
    padding: 0 0 16px 0;
  }
  .component-message--loading {
    pointer-events: none;
    opacity: 0.6;
  }
  .component-message__overlay {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    pointer-events: none;
  }
  .component-message__status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .component-message__status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--spectrum-global-color-blue-400, #3182ce);
    animation: component-message-pulse 1s ease-in-out infinite;
  }
  @keyframes component-message-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.6;
    }
    50% {
      transform: scale(1.4);
      opacity: 1;
    }
  }
</style>
