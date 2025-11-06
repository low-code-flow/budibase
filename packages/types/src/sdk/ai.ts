import { Message } from "../api"
import { AgentChat, AIProvider } from "../documents"
import type { ComponentPayload } from "./ai/components"
export * from "./ai/components"

export enum AIOperationEnum {
  SUMMARISE_TEXT = "SUMMARISE_TEXT",
  CLEAN_DATA = "CLEAN_DATA",
  TRANSLATE = "TRANSLATE",
  CATEGORISE_TEXT = "CATEGORISE_TEXT",
  SENTIMENT_ANALYSIS = "SENTIMENT_ANALYSIS",
  PROMPT = "PROMPT",
  SEARCH_WEB = "SEARCH_WEB",
}

export enum OperationFieldTypeEnum {
  MULTI_COLUMN = "columns",
  COLUMN = "column",
  BINDABLE_TEXT = "prompt",
}

export type OperationFieldsType = {
  [AIOperationEnum.SUMMARISE_TEXT]: {
    columns: OperationFieldTypeEnum.MULTI_COLUMN
  }
  [AIOperationEnum.CLEAN_DATA]: {
    column: OperationFieldTypeEnum.COLUMN
  }
  [AIOperationEnum.TRANSLATE]: {
    column: OperationFieldTypeEnum.COLUMN
    language: OperationFieldTypeEnum.BINDABLE_TEXT
  }
  [AIOperationEnum.CATEGORISE_TEXT]: {
    columns: OperationFieldTypeEnum.MULTI_COLUMN
    categories: OperationFieldTypeEnum.BINDABLE_TEXT
  }
  [AIOperationEnum.SENTIMENT_ANALYSIS]: {
    column: OperationFieldTypeEnum.COLUMN
  }
  [AIOperationEnum.PROMPT]: {
    prompt: OperationFieldTypeEnum.BINDABLE_TEXT
  }
  [AIOperationEnum.SEARCH_WEB]: {
    columns: OperationFieldTypeEnum.MULTI_COLUMN
  }
}

type BaseSchema = {
  operation: AIOperationEnum
}

type SummariseTextSchema = BaseSchema & {
  operation: AIOperationEnum.SUMMARISE_TEXT
  columns: string[]
}

type CleanDataSchema = BaseSchema & {
  operation: AIOperationEnum.CLEAN_DATA
  column: string
}

type TranslateSchema = BaseSchema & {
  operation: AIOperationEnum.TRANSLATE
  column: string
  language: string
}

type CategoriseTextSchema = BaseSchema & {
  operation: AIOperationEnum.CATEGORISE_TEXT
  columns: string[]
  categories: string[]
}

type SentimentAnalysisSchema = BaseSchema & {
  operation: AIOperationEnum.SENTIMENT_ANALYSIS
  column: string
}

type PromptSchema = BaseSchema & {
  operation: AIOperationEnum.PROMPT
  prompt: string
}

type SearchWebSchema = BaseSchema & {
  operation: AIOperationEnum.SEARCH_WEB
  columns: string[]
}

export type AIColumnSchema =
  | SummariseTextSchema
  | CleanDataSchema
  | TranslateSchema
  | CategoriseTextSchema
  | SentimentAnalysisSchema
  | PromptSchema
  | SearchWebSchema

export interface LLMConfigOptions {
  model: string
  apiKey?: string
  maxTokens?: number
  max_completion_tokens?: number
  // Primarily here for Azure OpenAI, because each customer has their own endpoint
  baseUrl?: string
}

export interface LLMProviderConfig extends LLMConfigOptions {
  provider: AIProvider
}

export interface LLMStreamChunk {
  type:
    | "content"
    | "tool_call_start"
    | "tool_call_result"
    | "done"
    | "error"
    | "chat_saved"
  content?: string
  toolCall?: {
    id: string
    name: string
    arguments: string
  }
  toolResult?: {
    id: string
    result: string
    error?: string
  }
  messages?: Message[]
  chat?: AgentChat
  tokensUsed?: number
}

export type AgentStreamEvent =
  | AgentResponseStartedEvent
  | AgentOutputTextDeltaEvent
  | AgentOutputTextCompletedEvent
  | AgentOutputItemCreatedEvent
  | AgentOutputItemUpdatedEvent
  | AgentToolCallStartedEvent
  | AgentToolCallCompletedEvent
  | AgentRunCompletedEvent
  | AgentRunErrorEvent
  | AgentRunSavedEvent

export type AgentStreamEventType =
  | "response.started"
  | "response.output_text.delta"
  | "response.output_text.completed"
  | "response.output_item.created"
  | "response.output_item.updated"
  | "response.tool_call.started"
  | "response.tool_call.completed"
  | "response.completed"
  | "response.error"
  | "response.saved"

export interface AgentStreamEventBase {
  eventId: string
  runId: string
  sequence: number
  timestamp: string
  type: AgentStreamEventType
}

export interface AgentResponseStartedEvent extends AgentStreamEventBase {
  type: "response.started"
  responseId: string
  metadata?: Record<string, unknown>
}

export interface AgentOutputTextDeltaEvent extends AgentStreamEventBase {
  type: "response.output_text.delta"
  responseId: string
  itemId: string
  delta: string
}

export interface AgentOutputTextCompletedEvent extends AgentStreamEventBase {
  type: "response.output_text.completed"
  responseId: string
  itemId: string
  text: string
}

export type AgentOutputItemType = "text" | "component"

export interface AgentOutputItemBase {
  id: string
  type: AgentOutputItemType
  role: "assistant" | "system"
  metadata?: Record<string, unknown>
}

export interface AgentOutputTextItem extends AgentOutputItemBase {
  type: "text"
  text: string
}

export interface AgentOutputComponentItem extends AgentOutputItemBase {
  type: "component"
  component: ComponentPayload
}

export type AgentOutputItem =
  | AgentOutputTextItem
  | AgentOutputComponentItem

export interface AgentOutputItemCreatedEvent extends AgentStreamEventBase {
  type: "response.output_item.created"
  responseId: string
  item: AgentOutputItem
}

export type AgentOutputItemState =
  | "pending"
  | "streaming"
  | "submitted"
  | "completed"
  | "hidden"
  | "error"

export interface AgentOutputItemPatch {
  state?: AgentOutputItemState
  metadata?: Record<string, unknown>
  replaceWith?: AgentOutputItem
}

export interface AgentOutputItemUpdatedEvent extends AgentStreamEventBase {
  type: "response.output_item.updated"
  responseId: string
  itemId: string
  patch: AgentOutputItemPatch
}

export interface AgentToolCallStartedEvent extends AgentStreamEventBase {
  type: "response.tool_call.started"
  responseId: string
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentToolCallCompletedEvent extends AgentStreamEventBase {
  type: "response.tool_call.completed"
  responseId: string
  callId: string
  status: "success" | "error"
  result?: Record<string, unknown> | string
  error?: {
    message: string
    code?: string
  }
  durationMs?: number
}

export interface AgentRunCompletedEvent extends AgentStreamEventBase {
  type: "response.completed"
  responseId: string
  tokensUsed?: number
  metadata?: Record<string, unknown>
}

export interface AgentRunErrorEvent extends AgentStreamEventBase {
  type: "response.error"
  responseId: string
  error: {
    message: string
    code?: string
    retryable?: boolean
  }
}

export interface AgentRunSavedEvent extends AgentStreamEventBase {
  type: "response.saved"
  responseId: string
  chatId: string
  revision?: string
  metadata?: Record<string, unknown>
}
