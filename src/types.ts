export interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  [key: string]: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | UnknownBlock;

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  [key: string]: unknown;
}

export interface AnthropicRequest {
  messages: Message[];
  system?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ToolCandidate {
  toolUseId: string;
  toolName: string;
  assistantMessageIndex: number;
  assistantBlockIndex: number;
  resultMessageIndex: number;
  resultBlockIndex: number;
  input: unknown;
  result: unknown;
}

export interface RelevanceScorer {
  score(
    goal: string,
    candidates: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>>;
}

export interface PruneResult {
  request: AnthropicRequest;
  beforeTokens: number;
  afterTokens: number;
  evaluated: number;
  dropped: number;
  reason:
    | "disabled"
    | "below-threshold"
    | "no-candidates"
    | "mid-task"
    | "pruned"
    | "fail-open";
  failureReason?: string;
  manual?: boolean;
  superseded?: number;
  trimmed?: number;
  resumed?: boolean;
  aboveTarget?: boolean;
  notice?: string;
}

export interface ProxyStats {
  requests: number;
  pruningDecisions: number;
  droppedPairs: number;
  failOpenEvents: number;
}
