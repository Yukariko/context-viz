import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Turn = {
  index: number;
  userText: string;
  answerSummary: string;
  messages: any[];
  files: string[];
  chars: number;
};

type Snapshot = {
  model: string;
  usage: string;
  systemChars: number;
  turns: Turn[];
  files: string[];
  commands: string[];
};

type OverlayResult =
  | { action: "close" }
  | { action: "prune"; selectedTurnIndexes: number[] };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context-viz", {
    description: "Show current LLM context as a right-side overlay",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const snapshot = buildSnapshot(ctx);
      const result = await ctx.ui.custom<OverlayResult>(
        (_tui, theme, _keybindings, done) => new ContextVizOverlay(snapshot, theme, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "46%",
            minWidth: 54,
            maxHeight: "90%",
            margin: 1,
          },
        },
      );

      if (!result || result.action !== "prune") return;

      const selected = snapshot.turns.filter((turn) => result.selectedTurnIndexes.includes(turn.index));
      if (selected.length === 0) {
        ctx.ui.notify("No turns selected; prune cancelled.", "warning");
        return;
      }

      await ctx.waitForIdle();
      const parentSession = ctx.sessionManager.getSessionFile();
      const copiedMessages = selected.flatMap((turn) => turn.messages.map(cloneJson));

      const switchResult = await ctx.newSession({
        parentSession,
        setup: async (sm: any) => {
          sm.appendSessionInfo?.(`Pruned context (${selected.length} turns)`);
          for (const message of copiedMessages) sm.appendMessage(message);
        },
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Pruned session created: ${selected.length}/${snapshot.turns.length} turns kept.`, "success");
        },
      });

      if (switchResult?.cancelled) ctx.ui.notify("Prune cancelled by session guard.", "warning");
    },
  });
}

function buildSnapshot(ctx: ExtensionCommandContext): Snapshot {
  const systemPrompt = safeString(ctx.getSystemPrompt?.() ?? "");
  const context = safeCall(() => ctx.sessionManager.buildSessionContext(), undefined as any);
  const messages: any[] = Array.isArray(context?.messages) ? context.messages : [];
  const usage = safeCall(() => ctx.getContextUsage?.(), undefined as any);

  const model = context?.model
    ? `${context.model.provider ?? ""}/${context.model.id ?? context.model.modelId ?? ""}`.replace(/^\//, "")
    : ctx.model
      ? `${(ctx.model as any).provider ?? ""}/${(ctx.model as any).id ?? ""}`.replace(/^\//, "")
      : "unknown";

  const usageText = usage
    ? `${formatNumber(usage.tokens ?? usage.totalTokens ?? 0)} tok${ctx.model?.contextWindow ? ` / ${formatNumber(ctx.model.contextWindow)}` : ""}`
    : "unknown";

  const turns = messagesToTurns(messages);
  const files = [...new Set(turns.flatMap((turn) => turn.files))].sort();
  const commands = collectRecentCommands(turns).slice(-12);

  return {
    model,
    usage: usageText,
    systemChars: systemPrompt.length,
    turns,
    files,
    commands,
  };
}

function messagesToTurns(messages: any[]): Turn[] {
  type Acc = {
    userText: string;
    messages: any[];
    files: Set<string>;
    commands: string[];
    chars: number;
    assistantMessages: number;
    toolResults: number;
    toolCounts: Map<string, number>;
    otherMessages: number;
    toolCalls: Map<string, { name: string; args: any }>;
  };

  const turns: Turn[] = [];
  let current: Acc | undefined;

  const flush = () => {
    if (!current) return;
    const tools = [...current.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
    const summary = [
      `A:${current.assistantMessages}`,
      current.toolResults > 0 ? `tools:${current.toolResults}${tools ? ` (${tools})` : ""}` : "tools:0",
      current.otherMessages > 0 ? `etc:${current.otherMessages}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    turns.push({
      index: turns.length,
      userText: current.userText,
      answerSummary: summary,
      messages: current.messages,
      files: [...current.files].sort(),
      chars: current.chars,
    });
    current = undefined;
  };

  for (const message of messages) {
    const role = String(message?.role ?? "unknown");
    const text = extractText(message?.content);

    if (role === "user") {
      flush();
      current = {
        userText: text || "[empty user message]",
        messages: [message],
        files: new Set(),
        commands: [],
        chars: text.length,
        assistantMessages: 0,
        toolResults: 0,
        toolCounts: new Map(),
        otherMessages: 0,
        toolCalls: new Map(),
      };
      continue;
    }

    if (!current) continue;

    current.messages.push(message);
    current.chars += text.length;

    if (role === "assistant") {
      current.assistantMessages++;
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (block?.type === "toolCall") {
            current.toolCalls.set(block.id, { name: block.name, args: block.arguments });
            collectToolArtifacts(block.name, block.arguments, current.files, current.commands);
          }
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const call = current.toolCalls.get(message.toolCallId);
      const tool = String(message?.toolName ?? call?.name ?? "tool");
      current.toolResults++;
      current.toolCounts.set(tool, (current.toolCounts.get(tool) ?? 0) + 1);
      collectToolArtifacts(tool, call?.args ?? message.details, current.files, current.commands);
      collectDetailsArtifacts(message.details, current.files, current.commands);
      continue;
    }

    if (role === "bashExecution") {
      current.otherMessages++;
      if (typeof message.command === "string") current.commands.push(message.command);
      continue;
    }

    current.otherMessages++;
  }

  flush();
  return turns;
}

function collectRecentCommands(turns: Turn[]): string[] {
  const commands: string[] = [];
  for (const turn of turns) {
    for (const message of turn.messages) {
      if (message?.role === "bashExecution" && typeof message.command === "string") commands.push(message.command);
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "toolCall" && block.name === "bash" && typeof block.arguments?.command === "string") {
            commands.push(block.arguments.command);
          }
        }
      }
    }
  }
  return commands;
}

function collectToolArtifacts(name: string | undefined, args: any, files: Set<string>, commands: string[]) {
  if (!name || !args || typeof args !== "object") return;
  const pathKeys = ["path", "file", "filePath"];
  for (const key of pathKeys) {
    if (typeof args[key] === "string" && args[key]) files.add(stripAt(args[key]));
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) if (typeof p === "string") files.add(stripAt(p));
  }
  if (name === "bash" && typeof args.command === "string") commands.push(args.command);
}

function collectDetailsArtifacts(details: any, files: Set<string>, commands: string[]) {
  if (!details || typeof details !== "object") return;
  for (const key of ["path", "file", "filePath", "fullOutputPath"]) {
    if (typeof details[key] === "string" && details[key]) files.add(stripAt(details[key]));
  }
  if (typeof details.command === "string") commands.push(details.command);
}

type BodyRow =
  | { type: "text"; text: string }
  | { type: "turn"; turnIndex: number; text: string }
  | { type: "file"; file: string; text: string };

class ContextVizOverlay {
  private scroll = 0;
  private cursor = 2;
  private readonly maxBodyLines = 34;
  private selectedTurns = new Set<number>();

  constructor(
    private snapshot: Snapshot,
    private theme: Theme,
    private done: (result: OverlayResult) => void,
  ) {
    for (const turn of snapshot.turns) this.selectedTurns.add(turn.index);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done({ action: "close" });
      return;
    }
    if (data === "p") {
      this.done({ action: "prune", selectedTurnIndexes: [...this.selectedTurns].sort((a, b) => a - b) });
      return;
    }

    const body = this.buildRows(Number.MAX_SAFE_INTEGER);
    if (matchesKey(data, "up") || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    if (matchesKey(data, "down") || data === "j") this.cursor = Math.min(body.length - 1, this.cursor + 1);
    if (matchesKey(data, "home")) this.cursor = 0;
    if (matchesKey(data, "end")) this.cursor = Math.max(0, body.length - 1);
    if (matchesKey(data, "space") || data === " ") this.toggleCurrent(body[this.cursor]);

    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + this.maxBodyLines) this.scroll = this.cursor - this.maxBodyLines + 1;
  }

  render(width: number): string[] {
    const w = Math.max(42, width);
    const innerW = w - 2;
    const th = this.theme;
    const body = this.buildRows(innerW);
    const maxScroll = Math.max(0, body.length - this.maxBodyLines);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visible = body.slice(this.scroll, this.scroll + this.maxBodyLines);

    const lines: string[] = [];
    lines.push(th.fg("borderAccent", `╭${"─".repeat(innerW)}╮`));
    lines.push(this.row(` ${th.fg("accent", th.bold("Context Visualizer"))}`, innerW));
    lines.push(this.row(` Model ${this.snapshot.model}`, innerW));
    lines.push(this.row(` Usage ${this.snapshot.usage}`, innerW));
    lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
    for (let i = 0; i < visible.length; i++) {
      const absolute = this.scroll + i;
      lines.push(this.row(this.renderBodyRow(visible[i]!, absolute === this.cursor), innerW));
    }
    if (visible.length < this.maxBodyLines) {
      for (let i = visible.length; i < this.maxBodyLines; i++) lines.push(this.row("", innerW));
    }
    lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
    const scrollInfo = maxScroll > 0 ? ` ${this.scroll + 1}-${Math.min(this.scroll + this.maxBodyLines, body.length)}/${body.length}` : "";
    const kept = `${this.selectedTurns.size}/${this.snapshot.turns.length} turns`;
    lines.push(this.row(` Space toggle • p prune • q close • ${kept}${scrollInfo}`, innerW));
    lines.push(th.fg("borderAccent", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  invalidate(): void {}

  private buildRows(_innerW: number): BodyRow[] {
    const th = this.theme;
    const rows: BodyRow[] = [];
    rows.push({ type: "text", text: ` ${th.fg("warning", "SYSTEM")} ${estimateTokens("x".repeat(this.snapshot.systemChars))} tok` });
    rows.push({ type: "text", text: "" });

    rows.push({ type: "text", text: ` ${th.fg("accent", "TURNS")} ${this.snapshot.turns.length}` });
    for (const turn of this.snapshot.turns) {
      const checked = this.selectedTurns.has(turn.index) ? "☑" : "☐";
      rows.push({ type: "turn", turnIndex: turn.index, text: ` ${checked} ${th.fg("accent", "Q")} ${compactText(turn.userText, 92)}` });
      rows.push({ type: "text", text: `     ${th.fg("success", "A")} ${turn.answerSummary}` });
    }

    rows.push({ type: "text", text: "" });
    rows.push({ type: "text", text: ` ${th.fg("success", "FILES")} ${this.checkedFiles().size}/${this.snapshot.files.length}` });
    if (this.snapshot.files.length === 0) rows.push({ type: "text", text: "   No file tool artifacts detected yet" });
    for (const file of this.snapshot.files.slice(0, 40)) {
      const checked = this.checkedFiles().has(file) ? "☑" : "☐";
      rows.push({ type: "file", file, text: ` ${checked} ${file}` });
    }
    if (this.snapshot.files.length > 40) rows.push({ type: "text", text: `   … +${this.snapshot.files.length - 40} more` });

    if (this.snapshot.commands.length) {
      rows.push({ type: "text", text: "" });
      rows.push({ type: "text", text: ` ${th.fg("warning", "RECENT BASH")}` });
      for (const command of this.snapshot.commands.slice(-8)) rows.push({ type: "text", text: `   $ ${compactText(command.replace(/\n/g, " ; "), 100)}` });
    }

    return rows;
  }

  private renderBodyRow(row: BodyRow, active: boolean): string {
    if (!active) return row.text;
    if (row.type === "turn" || row.type === "file") return this.theme.bg("selectedBg", `▶${row.text.slice(1)}`);
    return this.theme.bg("selectedBg", row.text || " ");
  }

  private toggleCurrent(row: BodyRow | undefined): void {
    if (!row) return;
    if (row.type === "turn") {
      if (this.selectedTurns.has(row.turnIndex)) this.selectedTurns.delete(row.turnIndex);
      else this.selectedTurns.add(row.turnIndex);
      return;
    }

    if (row.type === "file") {
      const related = this.snapshot.turns.filter((turn) => turn.files.includes(row.file));
      const currentlyChecked = related.some((turn) => this.selectedTurns.has(turn.index));
      for (const turn of related) {
        if (currentlyChecked) this.selectedTurns.delete(turn.index);
        else this.selectedTurns.add(turn.index);
      }
    }
  }

  private checkedFiles(): Set<string> {
    const files = new Set<string>();
    for (const turn of this.snapshot.turns) {
      if (!this.selectedTurns.has(turn.index)) continue;
      for (const file of turn.files) files.add(file);
    }
    return files;
  }

  private row(content: string, innerW: number): string {
    const clipped = truncateToWidth(content, innerW, "…");
    const pad = " ".repeat(Math.max(0, innerW - visibleWidth(clipped)));
    return this.theme.fg("border", "│") + clipped + pad + this.theme.fg("border", "│");
  }
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "thinking") return block.thinking ?? "";
      if (block?.type === "toolCall") return `[tool:${block.name} ${JSON.stringify(block.arguments ?? {})}]`;
      if (block?.type === "image") return "[image]";
      return "";
    })
    .join("\n");
}

function compactText(text: string, max: number): string {
  const oneLine = safeString(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(safeString(text).length / 4));
}

function stripAt(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
