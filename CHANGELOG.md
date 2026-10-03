# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-03

First release.

### Added

- Shell parser that understands quoting, substitutions, heredocs, `[[ ]]`, `if`/`case`, functions, and wrappers (`xargs`, `find -exec`, `sudo`, `timeout`, `sh -c`, `eval`).
- Platform scoping from `uname`/`$OSTYPE`/OS variables, `GNU`/`BSD` feature tests, `||` fallbacks and `command -v` guards.
- Extractors for shell scripts, Makefiles (including `ifeq` on `uname`), GitHub Actions workflows (`runs-on`, `matrix.os`, `container`, `if: runner.os`), Dockerfiles (per-stage base image), `package.json` scripts and Markdown.
- 95 rules covering differing flags, missing commands, bash 3.2 limitations on macOS and `sh` pitfalls, each with an executable probe.
- `portsh verify` to run every probe on the current machine; CI runs it on macOS, Ubuntu and Alpine.
- Output formats: text, JSON, SARIF, GitHub annotations.
- Configuration via `.portshrc.json` or `package.json`, per-path overrides and path hints, inline `# portsh-ignore` comments.
- `portsh rules` and `portsh explain <rule>`.
