import * as vscode from "vscode";
import * as path from "path";
import { ProjectMap } from "../types";

export class ContextBuilder {
  constructor(private readonly rootUri: vscode.Uri) {}

  async build(task: string, projectMap: ProjectMap | undefined): Promise<string> {
    const config = vscode.workspace.getConfiguration("flutterOllamaAgent");
    const maxContextFiles = config.get<number>("maxContextFiles", 8);
    const maxFileChars = config.get<number>("maxFileChars", 12000);

    const rules = await this.readRel(".agent-rules.md", 10000);

    const selected = selectRelevantFiles(task, projectMap, maxContextFiles);
    const fileBlocks: string[] = [];

    for (const relPath of selected) {
      const content = await this.readRel(relPath, maxFileChars);
      if (!content.trim()) {
        continue;
      }
      fileBlocks.push(`--- FILE: ${relPath} ---\n${content}`);
    }

    return [
      "You are a local Flutter coding agent running inside VS Code.",
      "Behave like an interactive coding partner: inspect, explain, then act in small steps.",
      "You must understand the repository before editing. Read the relevant files before proposing changes.",
      "Use get_active_editor when the user refers to the current file, open file, cursor position, or active editor.",
      "Use get_selected_text when the user refers to selected code, highlighted code, or this snippet.",
      "Use get_workspace_diagnostics when the user asks to fix errors, warnings, analyzer problems, or current diagnostics.",
      "Use search_files and grep to find relevant code before reading files when the target is uncertain.",
      "Use read_many_files when a task crosses multiple files.",
      "Use apply_patch for existing files whenever possible. Use write_file only when creating a new file or intentionally replacing a whole file.",
      "Before any write_file call, state the exact file path and a concise reason for the change.",
      "Before any apply_patch call, state the exact file path and the behavior you are changing.",
      "Before create_directory, rename_path, or delete_path, state the exact path or paths and why the file operation is needed.",
      "Prefer editing over deleting. Delete only when the user's request or a clearly obsolete generated file requires it.",
      "Only edit files that are directly required by the user's request.",
      "Never edit files outside the workspace.",
      "Never bypass approval. Writes and commands are guarded by the host extension.",
      "Prefer safe verification commands such as dart format, flutter analyze, and flutter test after edits.",
      "If a requested action is blocked by guardrails, explain what was blocked and suggest a safer next step.",
      "",
      "AGENT RULES",
      rules || "(No .agent-rules.md found. Follow standard Flutter best practices.)",
      "",
      "COMPACT PROJECT MAP",
      compactProjectMap(projectMap),
      "",
      "RELEVANT FILE CONTENTS",
      fileBlocks.join("\n\n") || "(No relevant files selected yet.)"
    ].join("\n");
  }

  private async readRel(relPath: string, maxChars: number): Promise<string> {
    try {
      const uri = vscode.Uri.joinPath(this.rootUri, ...relPath.split("/"));
      const data = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(data).toString("utf8").slice(0, maxChars);
    } catch {
      return "";
    }
  }
}

function compactProjectMap(projectMap: ProjectMap | undefined): string {
  if (!projectMap) {
    return "Project map unavailable.";
  }

  const importantFiles = projectMap.files
    .filter((f) => {
      return (
        f.path === "pubspec.yaml" ||
        f.path.includes("router") ||
        f.path.includes("route") ||
        f.path.includes("provider") ||
        f.path.includes("bloc") ||
        f.path.includes("repository") ||
        f.path.includes("service") ||
        f.path.includes("screen") ||
        f.path.includes("page") ||
        f.path.includes("widget") ||
        f.path.includes("model")
      );
    })
    .slice(0, 200)
    .map((f) => {
      const symbols = f.symbols
        .filter((s) => s.kind !== "import")
        .slice(0, 8)
        .map((s) => `${s.kind}:${s.name}`)
        .join(", ");
      return `${f.path}${symbols ? ` -> ${symbols}` : ""}`;
    })
    .join("\n");

  return [
    "Tree:",
    projectMap.tree,
    "",
    "Pubspec:",
    projectMap.pubspecSummary,
    "",
    "Important files:",
    importantFiles
  ].join("\n");
}

function selectRelevantFiles(task: string, projectMap: ProjectMap | undefined, maxFiles: number): string[] {
  if (!projectMap) {
    return [];
  }

  const taskTokens = tokenize(task);
  const defaultImportant = [
    "pubspec.yaml",
    "analysis_options.yaml",
    "lib/main.dart"
  ];

  const scored = projectMap.files.map((file) => {
    let score = 0;
    const lowerPath = file.path.toLowerCase();

    for (const token of taskTokens) {
      if (lowerPath.includes(token)) {
        score += 6;
      }

      for (const symbol of file.symbols) {
        if (symbol.name.toLowerCase().includes(token)) {
          score += 4;
        }
      }
    }

    if (lowerPath.includes("router") || lowerPath.includes("route")) score += taskMentionsAny(taskTokens, ["route", "routing", "screen", "navigation"]) ? 8 : 1;
    if (lowerPath.includes("auth")) score += taskMentionsAny(taskTokens, ["auth", "login", "signup", "password", "user"]) ? 8 : 0;
    if (lowerPath.includes("provider") || lowerPath.includes("bloc") || lowerPath.includes("controller")) score += taskMentionsAny(taskTokens, ["state", "provider", "bloc", "controller"]) ? 6 : 0;
    if (lowerPath.includes("repository") || lowerPath.includes("service") || lowerPath.includes("api")) score += taskMentionsAny(taskTokens, ["api", "service", "network", "backend", "repository"]) ? 6 : 0;
    if (lowerPath.endsWith("pubspec.yaml")) score += 4;
    if (lowerPath.endsWith("main.dart")) score += 4;

    return { path: file.path, score };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score > 0)
    .map((x) => x.path);

  for (const path of defaultImportant.reverse()) {
    if (projectMap.files.some((f) => f.path === path) && !selected.includes(path)) {
      selected.unshift(path);
    }
  }

  return selected.slice(0, maxFiles);
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9_\/.-]+/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    )
  );
}

function taskMentionsAny(tokens: string[], words: string[]): boolean {
  return words.some((word) => tokens.includes(word));
}
