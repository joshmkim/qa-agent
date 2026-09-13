/**
 * Minimal tool-calling chat abstraction. The exploration loop only needs
 * "send messages + tool schemas, get back text and/or tool calls", so any
 * provider with native tool use (Anthropic, Bedrock Converse, OpenAI) fits
 * behind this interface with a ~50 line adapter.
 */

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (object type). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  toolCallId: string;
  /** Text the model sees. Keep it structured and short. */
  content: string;
  isError?: boolean;
  /** Optional PNG screenshot shown to the model alongside the text. */
  imageBase64?: string;
}

export type ModelMessage =
  | { role: "user"; text: string }
  | { role: "user"; toolResults: ToolResultMessage[] }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[] };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ToolCall[];
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "other";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelClient {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
