# Flutter Ollama Agent

A minimal VS Code extension scaffold for a Flutter-aware local coding agent using Ollama.

## What it does

- Scans your Flutter workspace.
- Builds a compact project map from `lib/`, `test/`, `pubspec.yaml`, and `analysis_options.yaml`.
- Reads `.agent-rules.md` and injects it into every prompt.
- Selects relevant files for the current task.
- Calls local Ollama `/api/chat`.
- Shows a Cursor-like transcript with status, partial answers, tool calls, tool results, and final answers.
- Remembers recent user/assistant turns per workspace.
- Lets the model use safe tools:
  - `get_active_editor`
  - `get_selected_text`
  - `get_workspace_diagnostics`
  - `read_file`
  - `read_many_files`
  - `write_file`
  - `apply_patch`
  - `list_directory`
  - `search_files`
  - `grep`
  - `run_command`

Writes and commands require approval.

## Agent interaction model

The agent is designed to work in small, reviewable steps:

1. It scans the workspace before each prompt.
2. It builds a compact context from project rules, the project map, and relevant files.
3. It asks the local Ollama model what to do next.
4. It displays tool calls and tool results in the chat transcript.
5. It stops when the model returns a final answer or when `flutterOllamaAgent.maxAgentSteps` is reached.

The system prompt tells the model to inspect first, explain intended file changes, and then act only through guarded tools.

## Session memory

The extension stores recent user/assistant turns in VS Code workspace state so follow-up prompts can build on prior context.

- Memory is scoped to the current workspace path.
- Tool calls and tool results are not persisted, only user prompts and final assistant answers.
- The `Clear Session` button resets stored memory for the workspace.
- `flutterOllamaAgent.maxSessionTurns` controls how many recent turns are remembered.
- Set `flutterOllamaAgent.maxSessionTurns` to `0` to disable session memory.

## Cursor-like workflow foundation

The first Cursor-style agent layer is built around search, read, patch, and verify:

- `get_active_editor` tells the agent which workspace file is open, its language, dirty state, and selection range.
- `get_selected_text` gives the agent the highlighted code when you ask about a selection.
- `get_workspace_diagnostics` reads current VS Code Problems diagnostics for workspace files.
- `search_files` finds likely files by path.
- `grep` searches source text and returns `file:line` matches.
- `read_many_files` gathers up to 8 files for coordinated changes.
- `apply_patch` performs a guarded exact-text replacement in one existing file.
- `write_file` remains available for new files or intentional whole-file replacement.
- `run_command` verifies changes with approved Flutter, Dart, and Git commands.

For existing files, `apply_patch` is preferred because it requires exactly one matching `old_text` block. If the match is missing or ambiguous, the patch is rejected and the agent must inspect again.

Typical editor-aware prompts:

```text
Explain the selected widget and suggest a cleaner structure.
```

```text
Fix the current analyzer errors. Inspect diagnostics first, then patch only the necessary files.
```

## Permission flow

The extension requires explicit approval before:

- Creating or modifying files with `write_file`.
- Patching files with `apply_patch`.
- Running commands with `run_command`.

Approval prompts include the file path or command, the workspace directory, and enough context to decide whether the action is expected.

Rejecting an approval returns a tool result to the model. The model can then explain what happened or suggest a safer next step.

## Guardrails

Path guardrails:

- Tool paths must stay inside the current workspace.
- Parent directory traversal is blocked.
- Writes are blocked for `.git/`, `node_modules/`, `out/`, `build/`, `.dart_tool/`, and lock files.
- Patches use the same write guardrails as full-file writes.
- Generated output should be produced by commands such as `npm run compile`, not directly written by the model.

Command guardrails:

- Commands always require approval.
- Shell chaining, pipes, substitutions, and redirection are blocked.
- Allowed command families are:
  - `flutter analyze`
  - `flutter test`
  - `flutter pub get`
  - `flutter pub add`
  - `flutter build`
  - `flutter clean`
  - `dart format`
  - `dart analyze`
  - `dart test`
  - `dart pub`
  - `git status`
  - `git diff`
  - `git branch`
  - `git log`
  - `pwd`
  - `ls`

## Setup

```bash
ollama serve
ollama pull qwen3-coder:30b

npm install
npm run compile
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

In the Extension Development Host:

```text
Cmd/Ctrl + Shift + P
Flutter Ollama Agent: Open Chat
```

## Recommended model settings

Start with:

```text
qwen3-coder:30b
```

If it is too slow, try a smaller coding model available in your local Ollama.

## Add project rules

Copy `.agent-rules.example.md` into the root of your Flutter project as:

```text
.agent-rules.md
```

## Safety

This is an MVP. Keep it on local projects only. Review file paths, commands, and diffs before approving writes.

For best results, ask the agent to inspect and explain before editing. Example:

```text
Inspect the app architecture first. Then propose the exact files needed for login. Do not edit until you explain the plan.
```

## Current limitations

This extension is still not at full Cursor parity. The next major pieces are:

- Visual diff editor approval instead of modal text previews.
- Active editor and selected-text context.
- Long-running terminal sessions with cancellation.
- VS Code Problems integration for automatic fix loops.
- Rename/delete/create-directory tools with review.
- Stronger semantic indexing beyond regex and substring search.
