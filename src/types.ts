export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_name?: string;
}

export interface ToolCall {
  function: {
    name: string;
    arguments: unknown;
  };
}

export interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  error?: string;
}

export interface ProjectSymbol {
  kind: "class" | "function" | "provider" | "route" | "import" | "dependency";
  name: string;
}

export interface FileSummary {
  path: string;
  symbols: ProjectSymbol[];
  size: number;
}

export interface ProjectMap {
  root: string;
  pubspecSummary: string;
  analysisOptionsSummary: string;
  files: FileSummary[];
  tree: string;
  generatedAt: string;
}

export interface ResolvedPromptPath {
  raw: string;
  path: string;
  kind: "file" | "directory" | "missing";
  line?: number;
  character?: number;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}
