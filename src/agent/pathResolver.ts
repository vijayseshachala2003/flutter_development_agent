import * as vscode from "vscode";
import * as path from "path";
import { ResolvedPromptPath } from "../types";

const MAX_PROMPT_PATHS = 12;

export async function resolvePromptPaths(rootUri: vscode.Uri, prompt: string): Promise<ResolvedPromptPath[]> {
  const candidates = extractPathCandidates(prompt);
  const resolved: ResolvedPromptPath[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(rootUri, candidate);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.path}:${normalized.line ?? ""}:${normalized.character ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    resolved.push({
      raw: candidate.raw,
      path: normalized.path,
      kind: await getPathKind(vscode.Uri.joinPath(rootUri, ...normalized.path.split("/"))),
      line: normalized.line,
      character: normalized.character
    });

    if (resolved.length >= MAX_PROMPT_PATHS) {
      break;
    }
  }

  return resolved;
}

function extractPathCandidates(prompt: string): Array<{ raw: string; value: string; line?: number; character?: number }> {
  const candidates: Array<{ raw: string; value: string; line?: number; character?: number }> = [];
  const patterns = [
    /file:\/\/\/[^\s"'`)]+/g,
    /(?:[A-Za-z]:)?\/[^\s"'`)]+/g,
    /(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.@-]+(?:\.[\w.-]+)?(?::\d+)?(?::\d+)?/g
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const raw = trimPathToken(match[0]);
      const parsed = parseLineSuffix(raw);
      candidates.push({
        raw,
        value: parsed.value,
        line: parsed.line,
        character: parsed.character
      });
    }
  }

  return candidates;
}

function normalizeCandidate(
  rootUri: vscode.Uri,
  candidate: { raw: string; value: string; line?: number; character?: number }
): { path: string; line?: number; character?: number } | undefined {
  let candidatePath = candidate.value;

  if (candidatePath.startsWith("file://")) {
    try {
      candidatePath = vscode.Uri.parse(candidatePath).fsPath;
    } catch {
      return undefined;
    }
  }

  candidatePath = candidatePath.replace(/\\/g, "/");

  let absolutePath: string;
  if (path.isAbsolute(candidatePath)) {
    absolutePath = path.resolve(candidatePath);
  } else {
    absolutePath = path.resolve(rootUri.fsPath, candidatePath.replace(/^\.\/+/, ""));
  }

  const root = path.resolve(rootUri.fsPath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return {
    path: relative.replace(/\\/g, "/"),
    line: candidate.line,
    character: candidate.character
  };
}

async function getPathKind(uri: vscode.Uri): Promise<ResolvedPromptPath["kind"]> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory ? "directory" : "file";
  } catch {
    return "missing";
  }
}

function parseLineSuffix(raw: string): { value: string; line?: number; character?: number } {
  const match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) {
    return { value: raw };
  }

  return {
    value: match[1],
    line: Number(match[2]),
    character: match[3] ? Number(match[3]) : undefined
  };
}

function trimPathToken(token: string): string {
  return token.replace(/[),.;\]]+$/g, "");
}
