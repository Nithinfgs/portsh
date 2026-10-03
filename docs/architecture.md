# Architecture

portsh is a small pipeline with no runtime dependencies. Each stage is a plain function over plain data.

```text
discover ─► extract ─► parse ─► check ─► report
 scan.js    extract/   parse.js  engine.js  report.js
                                 rules/
```

## 1. Discovery (`src/scan.js`)

Uses `git ls-files` inside a repository (so `.gitignore` is respected), and a directory walk otherwise. Files are classified by name: scripts, Makefiles, GitHub workflows (`.github/workflows/*.yml`, `action.yml`), Dockerfiles, `package.json`, Markdown. Extensionless files are included when their shebang names a shell.

## 2. Extraction (`src/extract/`)

An extractor turns a file into one or more **chunks**:

```js
{
  text,        // shell source
  lineMap,     // for each chunk line: the file line and column it came from
  targets,     // platforms implied by context, or null
  dialect,     // bash | sh | zsh | unknown, from the shebang or the file type
}
```

Context is where most of the false-positive protection lives:

- **Dockerfile**: each `FROM` sets the platform of the following `RUN` lines (`alpine` is BusyBox; everything else is treated as a Debian-family Linux). Multi-stage builds are tracked by stage name.
- **GitHub Actions**: `runs-on`, `matrix.os`, `container:` and step-level `if: runner.os == 'Linux'` select the platform. `${{ }}` expressions are masked with same-length filler so columns stay correct.
- **Makefile**: only tab-indented recipe lines are shell. `$(VAR)` and `$(shell ...)` are neutralised, and `ifeq ($(UNAME_S),Darwin)` blocks become per-line platform restrictions.
- **Markdown / package.json**: fenced shell blocks and `scripts` entries, with the original positions preserved.

## 3. Parsing (`src/parse.js`)

A hand-written, forgiving tokenizer and command extractor. It understands quoting, `$(...)`, backticks, `<(...)`, here-documents, `[[ ... ]]`, arithmetic, `if`/`case`/loops, functions and line continuations. It produces a flat list of **simple commands**:

```js
{ name, words, args, line, col, restriction, fallback, ops, via }
```

- `restriction`: the platforms an enclosing `if [ "$(uname)" = Darwin ]`, `case "$OSTYPE" in`, `[ ... ] && cmd` or a `$GNU`/`$BSD` feature test limits the command to.
- `fallback`: the command is one side of `a || b`, an intentional alternative chain, so it is not judged on its own. (`|| true` is an error handler, not an alternative.)
- `unwrap()` exposes commands run *by* another command: `sudo`, `env`, `timeout`, `nice`, `xargs`, `find -exec`, `sh -c '...'`, `eval`.

It never executes anything and never expands variables. Malformed input yields fewer commands, not exceptions (the tests include unterminated quotes, heredocs and substitutions).

## 4. Rules (`src/rules/`)

A rule is data plus a matcher:

```js
{
  id: 'grep-perl-regexp',
  severity: 'error',
  fails: ['macos', 'alpine'],
  title, why, fix,
  commands: ['grep'],
  check(cmd, ctx) { /* return { message } or null */ },
  probes: [{ bad: "echo abc | grep -oP 'b\\w'", good: "echo abc | grep -oE 'b[[:alnum:]_]'", expect: 'bc' }],
}
```

`probes` are the rule's proof, and they drive three things: the static unit tests (`bad` must be flagged, `good` must not), `portsh verify` (actually run them), and the generated reference in `docs/rules.md`.

Tables (`LONG_OPTION_TABLE`, `MISSING_ON_MACOS`, `MISSING_ON_LINUX`) generate many rules from compact data.

## 5. The engine (`src/engine.js`)

For every command (and everything it wraps), the engine looks up rules by command name, skips guarded and fallback commands, and computes the platforms a hit applies to:

```text
rule.fails  ∩  targets (configured, or implied by file context)  ∩  command.restriction
```

If the intersection is empty there is no finding. This is why the same `sed -i ''` is fine inside `if [ "$(uname)" = Darwin ]`, a problem on Linux targets elsewhere, and invisible in a macOS-only job.

## 6. Reporting (`src/report.js`)

`text` (default), `json`, `sarif` (GitHub code scanning) and `github` (workflow annotations).

## Verification (`src/verify.js`)

Runs each probe in a temporary directory with `sh -c` (or the probe's shell) and compares reality with the rule on the current OS. The CI matrix runs it on macOS, Ubuntu, and Alpine (in a container).

## Design choices

- **Zero dependencies, no build step**: plain ES modules with JSDoc types checked by `tsc`, so `npx github:...` works instantly and there is no supply chain to audit.
- **Quiet over loud**: when the analyzer cannot tell whether a command is guarded, it assumes it is.
- **Evidence over folklore**: rules that Apple or Busybox have fixed are removed when `verify` says so.
