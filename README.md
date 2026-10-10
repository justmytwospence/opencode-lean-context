# opencode-lean-context

> **Retired.** Folded into [opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard),
> which trims tool output with Jev the same way and adds a one-second Jev summary path for a cold
> cache. Settings moved from `lean-context.json` to the `jev` and `trim` keys of `cache-guard.json`.

An [opencode](https://opencode.ai) plugin that keeps the context lean: large tool output is
trimmed to what the agent needs before it enters the context. [Jev](https://docs.typesafe.ai),
TypeSafe's fast judgment model, decides which lines matter in a few hundred milliseconds. The port
of [pi-lean-context](https://github.com/justmytwospence/pi-lean-context), with the same
pre-filter, blocks, questions and thresholds.

## Trimming tool output as it arrives

Text results over 12k characters from `bash`, `grep`, `glob`, `list`, `webfetch`, `websearch`,
MCP and other plugin tools (over 50k from `read`) are trimmed in `tool.execute.after`, before the
model sees them, so the prompt cache is never disturbed. Jev reads the agent's current step (the
latest request and what the assistant said since, from the session's messages) and the output,
split into at most 150 blocks, and says which blocks hold what the agent needs: errors, failures,
warnings, requested values, results. The kept blocks plus the first 5 and last 20 lines stay, in
order, with `[… N lines omitted …]` markers, and a footer points at the full output saved under
`~/.local/share/opencode/lean-context/<session>/<call>.txt`, to read with `offset`/`limit`.

Output too large for one Jev request is pre-filtered in code first (head, tail, every line that
looks like an error with two lines of context, and an even sample). Nothing is trimmed when Jev
thinks the agent wants the whole output, when more than 70% would be kept, when the same call was
already trimmed this turn (asking again returns everything), or when Jev is unavailable, fails or
takes over 2.5 s. `edit`, `write`, `apply_patch`, `task`, `todowrite`, `skill`, `question` and
`lsp` output is never trimmed.

opencode itself cuts tool output at 2,000 lines or 50 KB, keeps only a head or tail preview, and
saves the whole output under `~/.local/share/opencode/tool-output`. When it did, the plugin reads
that file back (up to 8 MB) and lets Jev pick from all of it, so an error in the cut middle still
reaches the agent; if the trim of the whole output is no smaller than opencode's preview, the preview
stays.

Each decision is logged under the `lean-context` service (`opencode run --print-logs`), and a toast
shows when output was trimmed.

## Not ported: compaction

pi-lean-context also has `/compact-jev`, which sorts the conversation into verbatim, summarize and
drop items and writes the summary in code, and it filters what Pi's own summarizer reads. opencode
plugins can add context to the compaction prompt but cannot replace the compaction model call or
filter the messages it reads, so compaction is left out of this port.

## Install

In `opencode.jsonc`, pinned to a commit:

```jsonc
"plugin": [
  "opencode-lean-context@github:justmytwospence/opencode-lean-context#<commit>"
]
```

Needs `TYPESAFE_API_KEY` in opencode's environment. Tested with opencode 1.18.29.

## Settings

Settings live in a shared, harness-neutral place that the pi and Claude Code ports of this plugin
read as well, so one file configures lean-context everywhere: `~/.config/agents/lean-context.json`
(under `$XDG_CONFIG_HOME` when set) for you, and `<project>/.agents/lean-context.json` for a
project. Keys a harness does not know are ignored, so pi-only keys such as `compact` in the same
file are fine. All keys are optional; the defaults:

```jsonc
{
  "enabled": true,
  "toast": true,
  "jev": { "model": "jev-latest", "timeoutMs": 2500 },
  "trim": {
    "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
    "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20
  }
}
```

opencode-only overrides go in the plugin's options in `opencode.jsonc` (the second element of the
plugin tuple, `["opencode-lean-context@...", { "toast": false }]`) or in
`<project>/.opencode/lean-context.json`. The layers merge in this order, later winning, objects
deep-merged and arrays and scalars replaced: built-in defaults, `~/.config/agents/lean-context.json`,
the `opencode.jsonc` options, `<project>/.agents/lean-context.json`,
`<project>/.opencode/lean-context.json`. The files are re-read when they change, so edits apply to
the next tool call without a restart; a missing or invalid file is ignored.

## Development

```sh
npm install
npm run check   # typecheck and tests
```

Try a local checkout in place of the pin: opencode dedupes plugins by package name and the later
config wins, so

```sh
printf '{"plugin":["opencode-lean-context@file:'"$PWD"'"]}' > /tmp/try.json
OPENCODE_CONFIG=/tmp/try.json opencode
```

links this checkout instead of the pinned commit.
