import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const INLINE_COMMAND_PATTERN = /(?:^|[ \t])\$([^\s$]*)$/;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["$"],

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const match = beforeCursor.match(INLINE_COMMAND_PATTERN);

        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const query = match[1] ?? "";
        const commands = pi
          .getCommands()
          .filter((command) => command.source === "skill" || command.source === "prompt");
        const matches = query
          ? fuzzyFilter(commands, query, (command) => `${command.name} ${command.description ?? ""}`)
          : commands;

        if (matches.length === 0) return null;

        return {
          prefix: `/${query}`,
          items: matches.map((command) => ({
            value: `/${command.name}`,
            label: command.name,
            description: command.description,
          })),
        };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const match = beforeCursor.match(INLINE_COMMAND_PATTERN);

        if (!match) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        }

        const token = `$${match[1] ?? ""}`;
        const tokenStart = cursorCol - token.length;
        const remaining = [...lines];
        remaining[cursorLine] = currentLine.slice(0, tokenStart) + currentLine.slice(cursorCol);

        const originalInput = remaining.join("\n").trim();
        const text = originalInput ? `${item.value} ${originalInput}` : item.value;
        const resultLines = text.split("\n");
        const resultCursorLine = resultLines.length - 1;

        return {
          lines: resultLines,
          cursorLine: resultCursorLine,
          cursorCol: resultLines[resultCursorLine]?.length ?? 0,
        };
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
