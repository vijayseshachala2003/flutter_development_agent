import * as vscode from "vscode";
import { ChatMessage, OllamaChatResponse } from "../types";

export class OllamaClient {
  private get baseUrl(): string {
    return vscode.workspace
      .getConfiguration("flutterOllamaAgent")
      .get<string>("ollamaUrl", "http://127.0.0.1:11434")
      .replace(/\/$/, "");
  }

  private get model(): string {
    return vscode.workspace
      .getConfiguration("flutterOllamaAgent")
      .get<string>("model", "qwen2.5-coder:14b");
  }

  async chat(messages: ChatMessage[]): Promise<OllamaChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: messages.map((m) => {
          if (m.role === "tool") {
            return {
              role: "tool",
              content: m.content
            };
          }

          return {
            role: m.role,
            content: m.content
          };
        }),
        tools: getToolSchemas(),
        options: {
          temperature: 0.1
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${text}`);
    }

    return (await response.json()) as OllamaChatResponse;
  }
}

function getToolSchemas() {
  return [
    {
      type: "function",
      function: {
        name: "get_active_editor",
        description: "Get the active editor file, language, dirty state, and selection range.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_selected_text",
        description: "Get selected text from the active editor when the user asks about this selection or current code.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_workspace_diagnostics",
        description: "Get current VS Code Problems diagnostics for files inside the workspace.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the current workspace. Use relative paths only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_many_files",
        description: "Read up to 8 files from the current workspace. Use this before coordinated multi-file edits.",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["paths"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a file in the current workspace. Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Patch one file by replacing exactly one old_text occurrence with new_text. Requires user approval and is preferred over write_file for existing files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" }
          },
          required: ["path", "old_text", "new_text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files/directories under a relative workspace path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search workspace file paths by substring. Use this to find likely files before reading them.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search text inside workspace source files by substring and return file:line matches.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a safe Flutter/Dart/Git command in the workspace. Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" }
          },
          required: ["command"]
        }
      }
    }
  ];
}
