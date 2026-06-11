import * as vscode from "vscode";
import { OllamaClient } from "../ollama/client";
import { ChatMessage, ProjectMap } from "../types";
import { ContextBuilder } from "./contextBuilder";
import { resolvePromptPaths } from "./pathResolver";
import { ToolExecutor } from "./toolExecutor";

export class AgentLoop {
  private readonly ollama = new OllamaClient();
  private readonly contextBuilder: ContextBuilder;
  private readonly toolExecutor: ToolExecutor;
  private readonly sessionKey: string;

  constructor(
    private readonly rootUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento
  ) {
    this.contextBuilder = new ContextBuilder(rootUri);
    this.toolExecutor = new ToolExecutor(rootUri);
    this.sessionKey = `flutterOllamaAgent.session.${rootUri.fsPath}`;
  }

  async clearSession(): Promise<void> {
    await this.workspaceState.update(this.sessionKey, []);
  }

  async run(
    userPrompt: string,
    projectMap: ProjectMap | undefined,
    onUpdate: (type: string, message: string) => void
  ): Promise<string> {
    const maxSteps = vscode.workspace
      .getConfiguration("flutterOllamaAgent")
      .get<number>("maxAgentSteps", 8);

    const promptPaths = await resolvePromptPaths(this.rootUri, userPrompt);
    if (promptPaths.length > 0) {
      onUpdate("status", `Resolved ${promptPaths.length} path(s) from prompt.`);
    }

    const systemContext = await this.contextBuilder.build(userPrompt, projectMap, promptPaths);

    const history = this.loadHistory();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemContext
      },
      ...history,
      {
        role: "user",
        content: userPrompt
      }
    ];

    let finalAnswer = "";

    for (let step = 0; step < maxSteps; step++) {
      onUpdate("status", `Thinking... step ${step + 1}/${maxSteps}`);

      const response = await this.ollama.chat(messages);
      if (response.error) {
        throw new Error(response.error);
      }

      const assistantContent = response.message?.content ?? "";
      const toolCalls = response.message?.tool_calls ?? [];

      if (assistantContent.trim()) {
        finalAnswer += `${assistantContent}\n\n`;
        onUpdate("assistantPartial", assistantContent);
      }

      messages.push({
        role: "assistant",
        content: assistantContent
      });

      if (toolCalls.length === 0) {
        onUpdate("status", "Agent finished without more tool calls.");
        const answer = finalAnswer.trim() || "Done.";
        await this.saveTurn(userPrompt, answer);
        return answer;
      }

      onUpdate("status", `Agent requested ${toolCalls.length} tool call(s).`);
      for (const call of toolCalls) {
        const name = call.function.name;
        onUpdate("toolCall", JSON.stringify(call.function, null, 2));

        let toolResult;
        try {
          toolResult = await this.toolExecutor.execute(name, call.function.arguments);
        } catch (error) {
          toolResult = {
            ok: false,
            content: String(error)
          };
        }

        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify(toolResult, null, 2)
        });

        onUpdate("toolResult", JSON.stringify({ name, result: toolResult }, null, 2));
      }
    }

    onUpdate("status", `Stopped after reaching max agent steps (${maxSteps}).`);
    const answer = (finalAnswer + "\nStopped after reaching max agent steps.").trim();
    await this.saveTurn(userPrompt, answer);
    return answer;
  }

  private loadHistory(): ChatMessage[] {
    const maxSessionTurns = vscode.workspace
      .getConfiguration("flutterOllamaAgent")
      .get<number>("maxSessionTurns", 6);
    const maxMessages = Math.max(0, maxSessionTurns * 2);
    if (maxMessages === 0) {
      return [];
    }

    const stored = this.workspaceState.get<ChatMessage[]>(this.sessionKey, []);
    return stored
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-maxMessages);
  }

  private async saveTurn(userPrompt: string, assistantAnswer: string): Promise<void> {
    const maxSessionTurns = vscode.workspace
      .getConfiguration("flutterOllamaAgent")
      .get<number>("maxSessionTurns", 6);
    const maxMessages = Math.max(0, maxSessionTurns * 2);
    if (maxMessages === 0) {
      await this.workspaceState.update(this.sessionKey, []);
      return;
    }

    const history = this.loadHistory();
    const userMessage: ChatMessage = { role: "user", content: userPrompt };
    const assistantMessage: ChatMessage = { role: "assistant", content: assistantAnswer };
    const nextHistory: ChatMessage[] = [
      ...history,
      userMessage,
      assistantMessage
    ].slice(-maxMessages);

    await this.workspaceState.update(this.sessionKey, nextHistory);
  }
}
