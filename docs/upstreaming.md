# Upstreaming the automation bridge

The connector needs a small patch to Graphite (`graphite-patch/automation-bridge.patch`). Carrying a patch means every
user of the connector runs a build of Graphite that differs from the official one, and every upstream change can break
the patch. The long-term fix is to get the bridge into Graphite itself, off by default. This document is the proposal
to bring to the Graphite maintainers, with the arguments and the open questions.

## What the patch adds

Four files, no new dependencies, no changes under `/editor`:

- `frontend/wrapper/src/editor_commands.rs`: eleven `automation_*` command functions. Each composes existing editor
  messages (`PortfolioMessage::NewDocumentWithName`, `GraphOperationMessage::NewSvg`, `FillColorSet`, `StrokeSet`,
  `OpacitySet`, `TransformChange`/`TransformSet`, `DocumentMessage::DeleteNode`, `NodeGraphMessage::SetDisplayName`,
  `DocumentMessage::Undo`/`Redo`, `PortfolioMessage::SubmitDocumentExport`). They follow the conventions of the file,
  compile into the desktop `EditorCommand` enum like every other command, and are inert unless called.
- `frontend/wrapper/src/editor_wrapper.rs`: a `graphiteCommitHash()` getter so clients can check compatibility.
- `frontend/src/automation-bridge.ts`: a WebSocket client that is completely inert unless the page is opened with
  `?automation=<token>` (or the token is already in `localStorage`). When enabled, it connects to a loopback endpoint,
  authenticates with the token, services a fixed list of commands, and observes `FrontendMessage`s to confirm results.
- `frontend/src/App.svelte`: three lines to create the bridge, let it see the message stream, and destroy it on unmount.

## Why Graphite might want it

- It gives Graphite a scriptable, data-driven automation surface without any GUI automation. Every command is a
  normal editor message, so undo, selection and the Layers panel behave exactly as for manual edits.
- It is opt-in per tab and loopback-only, with a shared secret. Stock behaviour does not change.
- The same commands work on the desktop build, because the wrapper macro compiles them into `EditorCommand`.
- It is small and self-contained, and it already has a consumer (this connector) with tests.

## What to ask the maintainers

1. Whether an opt-in bridge like this belongs in `frontend/` at all, or whether they would prefer the command
   functions only (the connector could then inject the WebSocket half at runtime).
2. Naming and placement of the `automation_*` commands. They could live in their own module instead of at the end
   of `editor_commands.rs`.
3. Whether ids should keep being supplied by the caller (as `NewSvg` already allows) or whether the wrapper should be
   able to return values.
4. A stable "layer created" confirmation. Today the bridge waits for `UpdateDocumentLayerStructure` to contain the new
   id, which is reliable but slow for large inserts; a dedicated `FrontendMessage` would be cleaner.

## How to open the discussion

1. Rebase the patch on current `master` and confirm `cargo run build web` still passes.
2. Open a discussion (not a pull request first) on the Graphite repository describing the use case, linking this
   connector, and attaching the patch. Ask questions 1 to 4 above.
3. If the answer is positive, split the change into two pull requests: the wrapper commands (trivial to review) and
   the bridge plus `App.svelte` wiring (the part that needs a design decision).

Until then, the patch lives here and the connector ships a pre-built Graphite so that end users are not affected.
