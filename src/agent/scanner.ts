import * as vscode from "vscode";
import * as path from "path";
import { FileSummary, ProjectMap, ProjectSymbol } from "../types";

const IGNORE_DIRS = new Set([
  ".git",
  ".dart_tool",
  "build",
  ".idea",
  ".vscode",
  "android",
  "ios",
  "macos",
  "linux",
  "windows",
  "web",
  "node_modules"
]);

export class ProjectScanner {
  private cache: ProjectMap | undefined;

  get projectMap(): ProjectMap | undefined {
    return this.cache;
  }

  async scan(rootUri: vscode.Uri): Promise<ProjectMap> {
    const pubspecSummary = await this.readShort(rootUri, "pubspec.yaml", 16000);
    const analysisOptionsSummary = await this.readShort(rootUri, "analysis_options.yaml", 8000);

    const files: FileSummary[] = [];
    await this.walk(rootUri, rootUri, files);

    const tree = this.buildTree(files.map((f) => f.path));
    this.cache = {
      root: rootUri.fsPath,
      pubspecSummary: summarizeYaml(pubspecSummary),
      analysisOptionsSummary: analysisOptionsSummary.slice(0, 3000),
      files,
      tree,
      generatedAt: new Date().toISOString()
    };

    return this.cache;
  }

  private async walk(rootUri: vscode.Uri, dirUri: vscode.Uri, files: FileSummary[]): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (IGNORE_DIRS.has(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(dirUri, name);
      const relPath = path.relative(rootUri.fsPath, childUri.fsPath).replace(/\\/g, "/");

      if (type === vscode.FileType.Directory) {
        if (relPath.split("/").length <= 8) {
          await this.walk(rootUri, childUri, files);
        }
        continue;
      }

      if (!shouldScanFile(relPath)) {
        continue;
      }

      const stat = await vscode.workspace.fs.stat(childUri);
      if (stat.size > 250_000) {
        continue;
      }

      const content = await this.readUri(childUri, 80_000);
      files.push({
        path: relPath,
        size: stat.size,
        symbols: extractSymbols(relPath, content)
      });
    }
  }

  private async readShort(rootUri: vscode.Uri, relPath: string, maxChars: number): Promise<string> {
    return this.readUri(vscode.Uri.joinPath(rootUri, relPath), maxChars);
  }

  private async readUri(uri: vscode.Uri, maxChars: number): Promise<string> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(data).toString("utf8").slice(0, maxChars);
    } catch {
      return "";
    }
  }

  private buildTree(paths: string[]): string {
    const sorted = [...paths].sort();
    return sorted.slice(0, 600).join("\n");
  }

  compactMap(): string {
    if (!this.cache) {
      return "Project map has not been generated yet.";
    }

    const files = this.cache.files
      .slice(0, 500)
      .map((f) => {
        const symbols = f.symbols
          .filter((s) => s.kind !== "import")
          .slice(0, 12)
          .map((s) => `${s.kind}:${s.name}`)
          .join(", ");
        return `- ${f.path}${symbols ? ` → ${symbols}` : ""}`;
      })
      .join("\n");

    return [
      `Generated: ${this.cache.generatedAt}`,
      "",
      "PROJECT TREE",
      this.cache.tree,
      "",
      "PUBSPEC SUMMARY",
      this.cache.pubspecSummary || "(none)",
      "",
      "ANALYSIS OPTIONS",
      this.cache.analysisOptionsSummary || "(none)",
      "",
      "FILE SYMBOLS",
      files
    ].join("\n");
  }
}

function shouldScanFile(relPath: string): boolean {
  if (relPath === "pubspec.yaml" || relPath === "analysis_options.yaml" || relPath === ".agent-rules.md") {
    return true;
  }

  return (
    relPath.startsWith("lib/") ||
    relPath.startsWith("test/") ||
    relPath.startsWith("integration_test/")
  ) && (
    relPath.endsWith(".dart") ||
    relPath.endsWith(".yaml") ||
    relPath.endsWith(".md")
  );
}

function extractSymbols(relPath: string, content: string): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];

  if (relPath.endsWith("pubspec.yaml")) {
    for (const match of content.matchAll(/^\s{2}([a-zA-Z0-9_]+):\s*[\^~>=<0-9]/gm)) {
      symbols.push({ kind: "dependency", name: match[1] });
    }
  }

  for (const match of content.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    symbols.push({ kind: "class", name: match[1] });
  }

  for (const match of content.matchAll(/(?:Future<[^>]+>|Future|Stream<[^>]+>|Widget|void|int|double|String|bool)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    symbols.push({ kind: "function", name: match[1] });
  }

  for (const match of content.matchAll(/\b(final|const)\s+([A-Za-z_][A-Za-z0-9_]*Provider)\b/g)) {
    symbols.push({ kind: "provider", name: match[2] });
  }

  for (const match of content.matchAll(/\bGoRoute\s*\(|\bRouteSettings\b|\broutes\s*:/g)) {
    symbols.push({ kind: "route", name: match[0].replace(/\s+/g, " ").slice(0, 30) });
  }

  for (const match of content.matchAll(/^import\s+['"]([^'"]+)['"];/gm)) {
    symbols.push({ kind: "import", name: match[1] });
  }

  return dedupeSymbols(symbols).slice(0, 80);
}

function dedupeSymbols(symbols: ProjectSymbol[]): ProjectSymbol[] {
  const seen = new Set<string>();
  const result: ProjectSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(symbol);
    }
  }
  return result;
}

function summarizeYaml(content: string): string {
  if (!content.trim()) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  const keep = lines.filter((line) => {
    return (
      line.startsWith("name:") ||
      line.startsWith("description:") ||
      line.startsWith("environment:") ||
      line.startsWith("dependencies:") ||
      line.startsWith("dev_dependencies:") ||
      /^\s{2}[a-zA-Z0-9_]+:/.test(line)
    );
  });

  return keep.slice(0, 160).join("\n");
}
