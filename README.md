# Hebros MCP

**An MCP server that gives coding agents a map of your codebase.**

To find its way around a project, an agent usually lists folders, searches for
text, and reads whole files. Every one of those steps costs tokens. Hebros reads
your code once and then answers directly: where something is defined, what a
file imports, who calls a function.

TypeScript and TSX. Nothing to configure, nothing running in the background.
The index is one JSON file in `~/.cache/hebros`, kept up to date from git as you
edit.

## Setup

Needs Node 22 or newer. Any MCP client works — point it at the `hebros` binary.

### Opencode

In `opencode.json`:

```json
{
  "mcp": {
    "hebros": {
      "type": "local",
      "command": ["npx", "-y", "hebros-mcp", "--root", "/path/to/repo"],
      "enabled": true
    }
  }
}
```

### Claude Code

```bash
claude mcp add hebros -- npx -y hebros-mcp --root /path/to/repo
```

The first `hebros` names the server locally, so its tools appear as
`mcp__hebros__get_map`. The second is the npm package.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.hebros]
command = "npx"
args = ["-y", "hebros-mcp", "--root", "/path/to/repo"]
```

`--root` is optional. Without it, Hebros indexes the folder you run it in, or
whatever `HEBROS_ROOT` points at.

## What the agent gets

| Tool | Answers |
|---|---|
| `get_map` | What's in this file or folder? Every name with its line number, no code bodies. For a file, also what it imports and what imports it. |
| `find_symbol` | Where is `X` defined? An exact file and line. |
| `get_deps` | What does this file or package use, and what uses it? |
| `get_references` | Where is `X` used? Every call site, grouped by file. |
| `reindex` | Force a refresh. You rarely need it — the other tools stay current on their own. |

For example, asking `find_symbol("buildEdges")` gets back:

```
src/imports.ts:427-445 + function buildEdges: export function buildEdges(...)
```

One line, instead of hunting through folders and opening three files.

Every answer stays under about 6 KB. When there's too much to fit, you get a
short summary saying where to look next, rather than a list that quietly stops
halfway.

The first question builds the index, which takes well under a second for a few
hundred files. After that Hebros asks git what changed and re-reads only those
files, so answers come back in milliseconds.

## It uses fewer tokens

Every file an agent opens fills up the space it has to think in. A map of a file
is much smaller than the file.

Here is what that looks like on a real project of 324 files:

| To answer | Without Hebros | With Hebros | |
|---|---|---|---|
| What's in this file? | read it — 4.5 KB | a map of it — 1.4 KB | **3x smaller** |
| Where is `useAppStore`? | search — 8 KB of matches to read | one line — 217 B | **37x smaller** |
| What's in this project? | a list of files — 13 KB | a map — 365 B | **36x smaller** |

Across 230 files, that is roughly 260,000 tokens of reading turned into 52,000.

How much you save depends on what you ask. A name used in 40 places is where it
helps most, because searching for it hands back 40 lines to read. A name used
once saves only about half. And on a small project — say 20 files — the map is
no smaller than a plain file list. What you get there is a precise answer rather
than a shorter one.

## Good for local models

This helps most when there isn't much room. A model running on your own machine
usually has space for 8,000 to 32,000 tokens, so one or two large files can use
it all up. The model also has to read the whole prompt before it says anything,
so a shorter prompt means a faster first word.

Hebros does the reading up front, on the CPU, and hands over a few hundred bytes
of ready-made answer. That leaves the space free for the actual work.

## Good to know

- TypeScript and TSX only. Other languages need a small adapter.
- `get_references` matches names as text, not by type. For a common name, pass
  `file` to narrow it down.
- It understands tsconfig `paths` and workspace packages (pnpm, npm, yarn).
- The index is plain JSON. Comfortable up to a few thousand files.

## More

- [docs/DESIGN.md](docs/DESIGN.md) — how the index works and why it's built this way
- [CONTRIBUTING.md](CONTRIBUTING.md) — local setup and ground rules

## License

MIT — see [LICENSE](LICENSE).
