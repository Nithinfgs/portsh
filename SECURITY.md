# Security Policy

## Scope

portsh is a static analyzer. It reads files and prints findings; it never executes the code it analyses.

The one command that runs code is `portsh verify`, which executes small, fixed snippets from the rule definitions (for example `sed -i ...` on a file it creates) inside a temporary directory it deletes afterwards. It runs nothing taken from your project.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. If that is unavailable, open an issue asking for a private contact without including details.

Examples worth reporting: a crafted file that makes the parser hang or consume unbounded memory, path traversal during file discovery, or a probe that can write outside its temporary directory.

You can expect an acknowledgement within a week. Fixes are released as patch versions and credited in the changelog unless you prefer otherwise.

## Supported versions

The latest released minor version.
