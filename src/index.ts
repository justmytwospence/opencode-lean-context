// opencode-lean-context: keeps opencode's context lean with Jev. Large tool output is trimmed as
// it arrives (`tool.execute.after`), before it enters the context, so the prompt cache is
// unaffected: Jev picks the blocks the agent needs for its current step; the rest is replaced by
// `[… N lines omitted …]` markers and the full output is saved to a file the agent can read.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { askJev, noul } from "./jev.ts";
import { type MessageLike, clip, clipTail, recentTexts } from "./transcript.ts";
import { DEFAULT_TRIM, type TrimSettings, assemble, makeBlocks, prefilter, trimFloor, trimQuestions } from "./trim.ts";

export interface Options {
  enabled: boolean;
  /** Show a toast when output is trimmed. */
  toast: boolean;
  jev: { model: string; timeoutMs: number };
  trim: TrimSettings;
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  toast: true,
  jev: { model: "jev-latest", timeoutMs: 2_500 },
  trim: DEFAULT_TRIM,
};

type Client = PluginInput["client"];

export function resolveOptions(raw: Record<string, unknown> | undefined): Options {
  const o = (raw ?? {}) as Partial<Options>;
  return {
    ...DEFAULT_OPTIONS,
    ...o,
    jev: { ...DEFAULT_OPTIONS.jev, ...(o.jev ?? {}) },
    trim: { ...DEFAULT_OPTIONS.trim, ...(o.trim ?? {}) },
  };
}

/** Where full output is saved: `$XDG_DATA_HOME/opencode/lean-context`, by default `~/.local/share/opencode/lean-context`. */
export function dataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "lean-context");
}

export function savePath(sessionID: string, callID: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/gu, "_");
  return path.join(dataDir(), safe(sessionID), `${safe(callID)}.txt`);
}

/** opencode's own truncation directory: `$XDG_DATA_HOME/opencode/tool-output`. */
export function opencodeOutputDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "tool-output");
}

/** Largest full output read back from opencode's truncation file. */
const MAX_FULL_BYTES = 8 * 1024 * 1024;

/**
 * The whole output when opencode truncated it (it keeps only a head or tail preview and saves the
 * rest under its tool-output directory, naming the file in a hint), so Jev can pick from all of it
 * rather than from the preview. Undefined when there is no such file or it cannot be read.
 */
export function untruncated(text: string, dir = opencodeOutputDir()): string | undefined {
  const match = /Full output saved to: (\S+)/u.exec(text);
  if (!match) return undefined;
  const file = path.resolve(match[1]!);
  if (path.dirname(file) !== path.resolve(dir)) return undefined;
  try {
    if (statSync(file).size > MAX_FULL_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function createHooks(client: Client, options: Options, fetchImpl?: typeof fetch): Promise<Hooks> {
  /** Per session, the tool calls trimmed this turn: the agent asking again gets everything. */
  const trimmed = new Map<string, Set<string>>();
  const log = (message: string) =>
    client.app.log({ body: { service: "lean-context", level: "info", message } }).catch(() => undefined);

  return {
    "chat.message": async (input) => {
      trimmed.delete(input.sessionID);
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") trimmed.delete((event.properties as { info: { id: string } }).info.id);
    },
    "tool.execute.after": async (input, output) => {
      if (!options.enabled) return;
      const floor = trimFloor(input.tool, options.trim);
      if (floor === undefined) return;
      const original = output.output;
      if (typeof original !== "string" || original.length <= floor) return;
      const text = untruncated(original) ?? original;
      const key = `${input.tool}:${JSON.stringify(input.args) ?? ""}`;
      if (trimmed.get(input.sessionID)?.has(key)) return;

      const lines = text.split("\n");
      const candidates = text.length > options.trim.stateBudgetChars ? prefilter(lines, options.trim.stateBudgetChars) : [...lines.keys()];
      const blocks = makeBlocks(lines, candidates, options.trim.maxBlocks);
      let messages: MessageLike[] = [];
      try {
        const { data } = await client.session.messages({ path: { id: input.sessionID } });
        messages = (data ?? []) as unknown as MessageLike[];
      } catch {
        // No history: Jev judges from the tool call alone.
      }
      const texts = recentTexts(messages);
      const state = {
        intent: {
          user_request: clip(texts.user, 1_500) || "(unknown)",
          agent_said: clipTail(texts.assistant, 2_000) || "(nothing; see the tool call)",
          tool: input.tool,
          arguments: clip(JSON.stringify(input.args) ?? "", 1_000),
        },
        output: Object.fromEntries(blocks.map((b) => [b.id, b.text])),
      };
      const outcome = await askJev(state, trimQuestions(blocks), {
        model: options.jev.model,
        timeoutMs: options.jev.timeoutMs,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      if (!outcome.ok) {
        await log(`${input.tool}: left whole, Jev unavailable (${outcome.reason})`);
        return;
      }
      const needsAll = noul(outcome.answers, "needs_all") ?? 0;
      const kept = blocks.filter((b) => (noul(outcome.answers, `block::${b.id}`) ?? 1) >= options.trim.keepThreshold);
      const fullPath = savePath(input.sessionID, input.callID);
      const result = assemble(lines, kept, options.trim, fullPath);
      const trim = needsAll <= options.trim.needsAllThreshold && result.keptLines / result.totalLines <= options.trim.maxKeptShare;
      const detail = `needs_all ${needsAll.toFixed(2)}, ${blocks.length} blocks, ${outcome.latencyMs} ms${outcome.inputTokens ? `, ${outcome.inputTokens} tokens` : ""}`;
      if (trim && result.text.length >= original.length) {
        await log(`${input.tool}: left opencode's preview, the trim of the full output is no smaller (${detail})`);
        return;
      }
      if (!trim) {
        await log(`${input.tool}: left whole, ${result.keptLines} of ${result.totalLines} lines needed (${detail})`);
        return;
      }
      try {
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, text);
      } catch (error) {
        await log(`${input.tool}: left whole, cannot save ${fullPath} (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
      const keys = trimmed.get(input.sessionID) ?? new Set<string>();
      keys.add(key);
      trimmed.set(input.sessionID, keys);
      output.output = result.text;
      const saved = Math.round((original.length - result.text.length) / 4_000);
      await log(`${input.tool}: kept ${result.keptLines} of ${result.totalLines} lines, about ${saved}k tokens saved (${detail}); full output ${fullPath}`);
      if (options.toast) {
        await client.tui
          .showToast({ body: { message: `lean-context: ${input.tool} output trimmed to ${result.keptLines} of ${result.totalLines} lines`, variant: "info" } })
          .catch(() => undefined);
      }
    },
  };
}

const server: Plugin = async (input, options) => createHooks(input.client, resolveOptions(options));

export default { id: "lean-context", server };
