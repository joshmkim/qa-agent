import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { ModelClient, ModelMessage, ModelRequest, ModelResponse, ToolCall } from "./types";

export interface AnthropicModelOptions {
  apiKey?: string;
  model?: string;
  /** Override for proxies / gateways. */
  baseURL?: string;
  /** Required by org-level keys that aren't scoped to a workspace (ANTHROPIC_WORKSPACE_ID). */
  workspaceId?: string;
  maxTokens?: number;
}

export const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Anthropic Messages API adapter. To run on Bedrock instead, construct the
 * client from `@anthropic-ai/bedrock-sdk` (same `messages.create` shape) and
 * pass it in.
 */
export class AnthropicModelClient implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicModelOptions = {}, client?: Anthropic) {
    this.model = opts.model ?? process.env.AGENT_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.name = `anthropic:${this.model}`;
    const workspaceId = opts.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
    this.client =
      client ??
      new Anthropic({
        apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
        baseURL: opts.baseURL ?? process.env.ANTHROPIC_BASE_URL,
        maxRetries: 3,
        ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
      });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const tools: Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Tool.InputSchema,
    }));

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokens,
      system: req.system,
      tools,
      messages: req.messages.map(toMessageParam),
    });

    const toolCalls: ToolCall[] = [];
    const texts: string[] = [];
    for (const block of res.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }

    return {
      text: texts.length ? texts.join("\n") : undefined,
      toolCalls,
      stopReason:
        res.stop_reason === "tool_use" || res.stop_reason === "end_turn" || res.stop_reason === "max_tokens"
          ? res.stop_reason
          : "other",
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

function toMessageParam(m: ModelMessage): MessageParam {
  if (m.role === "assistant") {
    const content: ContentBlockParam[] = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const call of m.toolCalls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
    }
    // The API rejects empty content; a bare assistant turn is a no-op text.
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] };
  }
  if ("text" in m) return { role: "user", content: m.text };
  const content: ToolResultBlockParam[] = m.toolResults.map((r) => ({
    type: "tool_result",
    tool_use_id: r.toolCallId,
    is_error: r.isError,
    content: r.imageBase64
      ? [
          { type: "text", text: r.content },
          { type: "image", source: { type: "base64", media_type: "image/png", data: r.imageBase64 } },
        ]
      : r.content,
  }));
  return { role: "user", content };
}
