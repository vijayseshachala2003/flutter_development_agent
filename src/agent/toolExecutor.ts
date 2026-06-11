import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { ToolResult } from "../types";

const MAX_SEARCH_RESULTS = 80;
const MAX_READ_MANY_FILES = 8;
const MAX_FILE_READ_CHARS = 30000;
const MAX_SELECTION_CHARS = 20000;
const MAX_DIAGNOSTICS = 80;
const SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  ".dart_tool",
  "build",
  "node_modules",
  "out",
  ".idea",
  ".vscode"
]);

export class ToolExecutor {
  constructor(private readonly rootUri: vscode.Uri) {}

  async execute(name: string, rawArgs: unknown): Promise<ToolResult> {
    const args = normalizeArgs(rawArgs);

    switch (name) {
      case "get_active_editor":
        return this.getActiveEditor();
      case "get_selected_text":
        return this.getSelectedText();
      case "get_workspace_diagnostics":
        return this.getWorkspaceDiagnostics();
      case "read_file":
        return this.readFile(requireString(args, "path"));
      case "read_many_files":
        return this.readManyFiles(requireStringArray(args, "paths"));
      case "write_file":
        return this.writeFile(requireString(args, "path"), requireString(args, "content"));
      case "apply_patch":
        return this.applyPatch(
          requireString(args, "path"),
          requireString(args, "old_text"),
          requireString(args, "new_text")
        );
      case "list_directory":
        return this.listDirectory(requireString(args, "path"));
      case "search_files":
        return this.searchFiles(requireString(args, "query"));
      case "grep":
        return this.grep(requireString(args, "query"));
      case "run_command":
        return this.runCommand(requireString(args, "command"));
      default:
        return {
          ok: false,
          content: `Unknown tool: ${name}`
        };
    }
  }

  private async getActiveEditor(): Promise<ToolResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return { ok: true, content: "No active text editor." };
    }

    const document = editor.document;
    const relPath = this.toWorkspacePath(document.uri);
    const selection = editor.selection;
    const payload = {
      path: relPath ?? document.uri.toString(),
      languageId: document.languageId,
      lineCount: document.lineCount,
      isDirty: document.isDirty,
      selection: {
        startLine: selection.start.line + 1,
        startCharacter: selection.start.character + 1,
        endLine: selection.end.line + 1,
        endCharacter: selection.end.character + 1,
        isEmpty: selection.isEmpty
      }
    };

    return {
      ok: true,
      content: JSON.stringify(payload, null, 2)
    };
  }

  private async getSelectedText(): Promise<ToolResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return { ok: true, content: "No active text editor." };
    }

    const relPath = this.toWorkspacePath(editor.document.uri);
    if (!relPath) {
      return { ok: false, content: "Active editor is outside the current workspace." };
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      return { ok: true, content: "No selected text." };
    }

    const selectedText = editor.document.getText(selection).slice(0, MAX_SELECTION_CHARS);
    const payload = {
      path: relPath,
      languageId: editor.document.languageId,
      selection: {
        startLine: selection.start.line + 1,
        startCharacter: selection.start.character + 1,
        endLine: selection.end.line + 1,
        endCharacter: selection.end.character + 1
      },
      text: selectedText
    };

    return {
      ok: true,
      content: JSON.stringify(payload, null, 2)
    };
  }

  private async getWorkspaceDiagnostics(): Promise<ToolResult> {
    const diagnostics = vscode.languages.getDiagnostics()
      .map(([uri, items]) => {
        const relPath = this.toWorkspacePath(uri);
        if (!relPath) {
          return [];
        }

        return items.map((diagnostic) => ({
          path: relPath,
          severity: diagnosticSeverityName(diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.source,
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1
        }));
      })
      .flat()
      .slice(0, MAX_DIAGNOSTICS);

    return {
      ok: true,
      content: diagnostics.length ? JSON.stringify(diagnostics, null, 2) : "No workspace diagnostics."
    };
  }

  private async readFile(relPath: string): Promise<ToolResult> {
    const uri = this.resolveSafe(relPath);
    if (!uri) {
      return { ok: false, content: `Blocked unsafe path: ${relPath}` };
    }

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return {
        ok: true,
        content: Buffer.from(data).toString("utf8").slice(0, MAX_FILE_READ_CHARS)
      };
    } catch (error) {
      return {
        ok: false,
        content: `Failed to read ${relPath}: ${String(error)}`
      };
    }
  }

  private async readManyFiles(relPaths: string[]): Promise<ToolResult> {
    const uniquePaths = Array.from(new Set(relPaths)).slice(0, MAX_READ_MANY_FILES);
    const blocks: string[] = [];

    for (const relPath of uniquePaths) {
      const result = await this.readFile(relPath);
      blocks.push(`--- FILE: ${relPath} ---\n${result.ok ? result.content : `ERROR: ${result.content}`}`);
    }

    return {
      ok: true,
      content: blocks.join("\n\n")
    };
  }

  private async writeFile(relPath: string, content: string): Promise<ToolResult> {
    const uri = this.resolveSafe(relPath);
    if (!uri) {
      return { ok: false, content: `Blocked unsafe path: ${relPath}` };
    }

    const pathBlockReason = getBlockedWriteReason(relPath);
    if (pathBlockReason) {
      return { ok: false, content: `Blocked write to ${relPath}: ${pathBlockReason}` };
    }

    const stat = await statIfExists(uri);
    const action = stat ? "modify" : "create";

    const approved = await vscode.window.showWarningMessage(
      [
        `Flutter Ollama Agent wants to ${action}:`,
        "",
        relPath,
        "",
        `New content size: ${Buffer.byteLength(content, "utf8")} bytes`,
        "",
        "Review this path before approving. The extension will not write without approval."
      ].join("\n"),
      { modal: true },
      "Approve",
      "Reject"
    );

    if (approved !== "Approve") {
      return { ok: false, content: `User rejected write_file(${relPath}).` };
    }

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return { ok: true, content: `Wrote ${relPath}` };
    } catch (error) {
      return { ok: false, content: `Failed to write ${relPath}: ${String(error)}` };
    }
  }

  private async applyPatch(relPath: string, oldText: string, newText: string): Promise<ToolResult> {
    const uri = this.resolveSafe(relPath);
    if (!uri) {
      return { ok: false, content: `Blocked unsafe path: ${relPath}` };
    }

    const pathBlockReason = getBlockedWriteReason(relPath);
    if (pathBlockReason) {
      return { ok: false, content: `Blocked patch to ${relPath}: ${pathBlockReason}` };
    }

    if (!oldText) {
      return { ok: false, content: "Blocked patch: old_text must not be empty." };
    }

    let current: string;
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      current = Buffer.from(data).toString("utf8");
    } catch (error) {
      return { ok: false, content: `Failed to read ${relPath}: ${String(error)}` };
    }

    const matches = countOccurrences(current, oldText);
    if (matches !== 1) {
      return {
        ok: false,
        content: `Patch requires exactly one old_text match in ${relPath}; found ${matches}.`
      };
    }

    const preview = [
      `Flutter Ollama Agent wants to patch:`,
      "",
      relPath,
      "",
      "Replace:",
      truncateForPrompt(oldText),
      "",
      "With:",
      truncateForPrompt(newText),
      "",
      "Review this exact-text replacement before approving."
    ].join("\n");

    const approved = await vscode.window.showWarningMessage(
      preview,
      { modal: true },
      "Approve",
      "Reject"
    );

    if (approved !== "Approve") {
      return { ok: false, content: `User rejected apply_patch(${relPath}).` };
    }

    try {
      const updated = current.replace(oldText, newText);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, "utf8"));
      return { ok: true, content: `Patched ${relPath}` };
    } catch (error) {
      return { ok: false, content: `Failed to patch ${relPath}: ${String(error)}` };
    }
  }

  private async listDirectory(relPath: string): Promise<ToolResult> {
    const uri = this.resolveSafe(relPath);
    if (!uri) {
      return { ok: false, content: `Blocked unsafe path: ${relPath}` };
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const content = entries
        .map(([name, type]) => {
          const suffix = type === vscode.FileType.Directory ? "/" : "";
          return `${name}${suffix}`;
        })
        .sort()
        .join("\n");

      return { ok: true, content };
    } catch (error) {
      return { ok: false, content: `Failed to list ${relPath}: ${String(error)}` };
    }
  }

  private async searchFiles(query: string): Promise<ToolResult> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { ok: false, content: "search_files query must not be empty." };
    }

    const files = await this.collectFiles(this.rootUri);
    const matches = files
      .filter((relPath) => relPath.toLowerCase().includes(needle))
      .slice(0, MAX_SEARCH_RESULTS);

    return {
      ok: true,
      content: matches.length ? matches.join("\n") : "No matching files found."
    };
  }

  private async grep(query: string): Promise<ToolResult> {
    const needle = query.trim();
    if (!needle) {
      return { ok: false, content: "grep query must not be empty." };
    }

    const files = await this.collectFiles(this.rootUri);
    const matches: string[] = [];

    for (const relPath of files) {
      if (!isTextSearchFile(relPath)) {
        continue;
      }

      const uri = this.resolveSafe(relPath);
      if (!uri) {
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 250_000) {
          continue;
        }

        const data = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(data).toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
            matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            if (matches.length >= MAX_SEARCH_RESULTS) {
              return { ok: true, content: matches.join("\n") };
            }
          }
        }
      } catch {
        continue;
      }
    }

    return {
      ok: true,
      content: matches.length ? matches.join("\n") : "No text matches found."
    };
  }

  private async runCommand(command: string): Promise<ToolResult> {
    const blockReason = getCommandBlockReason(command);
    if (blockReason) {
      return {
        ok: false,
        content: `Blocked command: ${blockReason}. Command was: ${command}`
      };
    }

    const approved = await vscode.window.showWarningMessage(
      [
        "Flutter Ollama Agent wants to run this command in the workspace:",
        "",
        command,
        "",
        `Working directory: ${this.rootUri.fsPath}`,
        "",
        "Only approve commands you understand."
      ].join("\n"),
      { modal: true },
      "Approve",
      "Reject"
    );

    if (approved !== "Approve") {
      return { ok: false, content: `User rejected run_command(${command}).` };
    }

    return new Promise((resolve) => {
      cp.exec(
        command,
        {
          cwd: this.rootUri.fsPath,
          timeout: 120_000,
          maxBuffer: 2_000_000,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash"
        },
        (error, stdout, stderr) => {
          const output = [
            stdout ? `STDOUT:\n${stdout}` : "",
            stderr ? `STDERR:\n${stderr}` : "",
            error ? `ERROR:\n${error.message}` : ""
          ].filter(Boolean).join("\n\n");

          resolve({
            ok: !error,
            content: output.slice(0, 50000)
          });
        }
      );
    });
  }

  private resolveSafe(relPath: string): vscode.Uri | undefined {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0")) {
      return undefined;
    }

    const resolved = path.resolve(this.rootUri.fsPath, normalized);
    const root = path.resolve(this.rootUri.fsPath);
    const relative = path.relative(root, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }

    return vscode.Uri.file(resolved);
  }

  private toWorkspacePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }

    const root = path.resolve(this.rootUri.fsPath);
    const filePath = path.resolve(uri.fsPath);
    const relative = path.relative(root, filePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }

    return relative.replace(/\\/g, "/");
  }

  private async collectFiles(dirUri: vscode.Uri, baseUri = this.rootUri, depth = 0): Promise<string[]> {
    if (depth > 10) {
      return [];
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return [];
    }

    const results: string[] = [];
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && SEARCH_EXCLUDED_DIRS.has(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(dirUri, name);
      const relPath = path.relative(baseUri.fsPath, childUri.fsPath).replace(/\\/g, "/");

      if (type === vscode.FileType.Directory) {
        results.push(...await this.collectFiles(childUri, baseUri, depth + 1));
      } else if (type === vscode.FileType.File) {
        results.push(relPath);
      }
    }

    return results.sort();
  }
}

function normalizeArgs(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  if (rawArgs && typeof rawArgs === "object") {
    return rawArgs as Record<string, unknown>;
  }

  return {};
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument '${key}' must be a string.`);
  }
  return value;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Tool argument '${key}' must be an array of strings.`);
  }
  return value as string[];
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}

async function statIfExists(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

function getBlockedWriteReason(relPath: string): string | undefined {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  const first = parts[0];

  if (!normalized.trim()) return "empty path";
  if (parts.includes("..")) return "parent directory traversal is not allowed";
  if (first === ".git") return "git internals are read-only";
  if (first === "node_modules") return "dependencies are managed by the package manager";
  if (first === "out") return "compiled output should be produced by npm run compile";
  if (first === "build" || first === ".dart_tool") return "generated Flutter output is read-only";
  if (normalized.endsWith(".lock")) return "lock files require manual review outside the agent";

  return undefined;
}

function getCommandBlockReason(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return "empty command";
  if (/[;&|`$<>]/.test(trimmed)) {
    return "shell chaining, pipes, substitutions, and redirection are not allowed";
  }

  if (/^flutter\s+(analyze|test|pub\s+get|pub\s+add|build|clean)\b/.test(trimmed)) return undefined;
  if (/^dart\s+(format|analyze|test|pub)\b/.test(trimmed)) return undefined;
  if (/^git\s+(status|diff|branch|log)\b/.test(trimmed)) return undefined;
  if (/^(pwd|ls)(\s|$)/.test(trimmed)) return undefined;

  return "allowed commands are flutter analyze/test/pub get/pub add/build/clean, dart format/analyze/test/pub, git status/diff/branch/log, pwd, and ls";
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) {
      return count;
    }
    count++;
    index += needle.length;
  }
}

function truncateForPrompt(text: string): string {
  const limit = 1800;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n... (${text.length - limit} more characters)`;
}

function isTextSearchFile(relPath: string): boolean {
  return [
    ".dart",
    ".yaml",
    ".yml",
    ".json",
    ".md",
    ".ts",
    ".js",
    ".html",
    ".css"
  ].some((suffix) => relPath.endsWith(suffix));
}
