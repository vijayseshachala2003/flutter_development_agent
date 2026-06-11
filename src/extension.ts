import * as vscode from "vscode";
import { ProjectScanner } from "./agent/scanner";
import { AgentPanel } from "./webview/panel";

let scanner: ProjectScanner | undefined;

export async function activate(context: vscode.ExtensionContext) {
  scanner = new ProjectScanner();

  context.subscriptions.push(
    vscode.commands.registerCommand("flutterOllamaAgent.openChat", async () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Open a Flutter workspace folder first.");
        return;
      }

      await scanner!.scan(workspaceFolder.uri);
      AgentPanel.createOrShow(context.extensionUri, workspaceFolder.uri, scanner!, context.workspaceState);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flutterOllamaAgent.rescanProject", async () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Open a Flutter workspace folder first.");
        return;
      }

      await scanner!.scan(workspaceFolder.uri);
      vscode.window.showInformationMessage("Flutter Ollama Agent: project scan refreshed.");
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{dart,yaml,md}");
  watcher.onDidChange(async (uri) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder && scanner) {
      await scanner.scan(workspaceFolder.uri);
    }
  });
  watcher.onDidCreate(async (uri) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder && scanner) {
      await scanner.scan(workspaceFolder.uri);
    }
  });
  watcher.onDidDelete(async (uri) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder && scanner) {
      await scanner.scan(workspaceFolder.uri);
    }
  });
  context.subscriptions.push(watcher);
}

export function deactivate() {}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return undefined;
  }
  return vscode.workspace.workspaceFolders[0];
}
