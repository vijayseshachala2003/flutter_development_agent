import * as vscode from "vscode";
import { AgentLoop } from "../agent/agentLoop";
import { ProjectScanner } from "../agent/scanner";

export class AgentPanel {
  public static currentPanel: AgentPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly agentLoop: AgentLoop;

  static createOrShow(
    extensionUri: vscode.Uri,
    rootUri: vscode.Uri,
    scanner: ProjectScanner,
    workspaceState: vscode.Memento
  ) {
    if (AgentPanel.currentPanel) {
      AgentPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "flutterOllamaAgent",
      "Flutter Ollama Agent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    AgentPanel.currentPanel = new AgentPanel(panel, extensionUri, rootUri, scanner, workspaceState);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    rootUri: vscode.Uri,
    private readonly scanner: ProjectScanner,
    workspaceState: vscode.Memento
  ) {
    this.panel = panel;
    this.agentLoop = new AgentLoop(rootUri, workspaceState);

    this.panel.webview.html = getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      AgentPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "ready":
            this.post("status", "Extension host connected.");
            return;
          case "prompt": {
            const prompt = String(message.text ?? "").trim();
            if (!prompt) {
              this.post("status", "Prompt is empty.");
              return;
            }

            this.post("status", "Scanning project...");
            await this.scanner.scan(rootUri);

            const answer = await this.agentLoop.run(
              prompt,
              this.scanner.projectMap,
              (type, text) => this.post(type, text)
            );
            this.post("assistant", answer);
            return;
          }
          case "rescan":
            this.post("status", "Rescanning project...");
            await this.scanner.scan(rootUri);
            this.post("status", "Project scan refreshed.");
            return;
          case "clearSession":
            await this.agentLoop.clearSession();
            this.post("status", "Session memory cleared.");
            return;
          default:
            this.post("error", "Unknown webview message: " + String(message.type));
            return;
        }
      } catch (error) {
        this.post("error", String(error));
      }
    });
  }

  private post(type: string, text: string) {
    this.panel.webview.postMessage({ type, text });
  }
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flutter Ollama Agent</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h2 {
      margin-top: 0;
    }
    textarea {
      width: 100%;
      min-height: 110px;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      padding: 10px;
      resize: vertical;
    }
    button {
      margin-top: 8px;
      margin-right: 8px;
      padding: 8px 12px;
      border: none;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .log {
      margin-top: 16px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .progressWrap {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }
    progress {
      width: 320px;
      height: 14px;
    }
    .stepInfo {
      min-width: 160px;
      font-size: 0.9em;
      opacity: 0.9;
    }
    .entry {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px 0;
    }
    .role {
      font-weight: 700;
      margin-bottom: 6px;
    }
    .status {
      opacity: 0.75;
      font-style: italic;
    }
    .assistantPartial {
      background: rgba(100, 140, 255, 0.04);
    }
    .assistantFinal {
      background: rgba(60, 200, 120, 0.04);
    }
    .toolCall {
      background: rgba(255, 200, 80, 0.04);
    }
    .toolResult {
      background: rgba(200, 200, 200, 0.03);
    }
    .badge {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-size: 0.8em;
      vertical-align: middle;
    }
    .error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <h2>Flutter Ollama Agent</h2>
  <p>Local Flutter-aware coding agent using Ollama. Recent chat turns are remembered for this workspace.</p>

  <textarea id="prompt" placeholder="Example: Inspect the app architecture. Do not edit yet. Explain routing, state management, and feature folder structure."></textarea>
  <br />
  <button id="send" type="button">Send</button>
  <button id="rescan" type="button">Rescan Project</button>
  <button id="clearSession" type="button">Clear Session</button>

  <div class="progressWrap">
    <progress id="progress" max="8" value="0"></progress>
    <div class="stepInfo" id="stepInfo">Idle</div>
  </div>

  <div id="log" class="log"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let promptEl;
    let logEl;
    let progressEl;
    let stepInfoEl;
    let initialized = false;

    function init() {
      if (initialized) return;
      initialized = true;
      promptEl = document.getElementById("prompt");
      logEl = document.getElementById("log");
      progressEl = document.getElementById("progress");
      stepInfoEl = document.getElementById("stepInfo");

      if (!promptEl || !logEl || !progressEl || !stepInfoEl) {
        return;
      }

      bindButton("send", () => {
        const text = promptEl.value.trim();
        if (!text) return;
        addEntry("You", text);
        promptEl.value = "";
        vscode.postMessage({ type: "prompt", text });
      });

      bindButton("rescan", () => {
        addEntry("You", "Rescan Project");
        vscode.postMessage({ type: "rescan" });
      });

      bindButton("clearSession", () => {
        addEntry("You", "Clear Session");
        vscode.postMessage({ type: "clearSession" });
      });

      addEntry("Status", "Webview ready.", "status");
      vscode.postMessage({ type: "ready" });
    }

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }

    window.addEventListener("message", (event) => {
      const { type, text } = event.data;
      if (type === "assistant") addEntry("Agent", text, "assistantFinal");
      if (type === "assistantPartial") {
        addEntry("Agent (partial)", text, "assistantPartial");
        updateProgressFromText(text);
      }
      if (type === "status") {
        addEntry("Status", text, "status");
        updateProgressFromText(text);
      }
      if (type === "toolCall") addEntry("Tool Call", text, "toolCall");
      if (type === "toolResult") addEntry("Tool Result", text, "toolResult");
      if (type === "error") addEntry("Error", text, "error");
    });

    window.addEventListener("error", (event) => {
      addEntry("Webview Error", event.message || String(event.error), "error");
    });

    function bindButton(id, handler) {
      const button = document.getElementById(id);
      if (!button) {
        addEntry("Webview Error", "Missing button: " + id, "error");
        return;
      }

      button.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          handler();
        } catch (error) {
          addEntry("Webview Error", String(error), "error");
        }
      });
    }

    function addEntry(role, text, className = "") {
      if (!logEl) return;
      const entry = document.createElement("div");
      entry.className = "entry " + className;

      const roleEl = document.createElement("div");
      roleEl.className = "role";
      roleEl.textContent = role;

      // Show approval badge for guarded tool calls.
      if (className === "toolCall" && /\"name\"\s*:\s*\"(write_file|apply_patch|create_directory|rename_path|delete_path|run_command)\"/.test(text)) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Requires Approval";
        roleEl.appendChild(document.createTextNode(" "));
        roleEl.appendChild(badge);
      }

      const textEl = document.createElement("div");
      textEl.textContent = text;

      entry.appendChild(roleEl);
      entry.appendChild(textEl);
      logEl.prepend(entry);
    }

    function updateProgressFromText(text) {
      if (!text) return;
      const m = text.match(/step\s*(\\d+)\s*\/\s*(\\d+)/i);
      if (m) {
        const cur = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        if (progressEl) {
          progressEl.max = tot;
          progressEl.value = cur;
        }
        if (stepInfoEl) {
          stepInfoEl.textContent = 'Step ' + cur + '/' + tot;
        }
        return;
      }
      if (stepInfoEl) {
        stepInfoEl.textContent = text.slice(0, 60);
      }
    }
  </script>
</body>
</html>
`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
