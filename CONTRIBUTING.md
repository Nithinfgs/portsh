# Contributing

Thanks for helping. The most valuable contributions are **rules backed by evidence** and **false-positive reports with a minimal snippet**.

## Setup

```sh
git clone https://github.com/Nithinfgs/portsh && cd portsh
npm ci
npm run check      # lint + typecheck + tests
npm run verify     # run every rule's proof on this machine
```

Node 18+. There is no build step; the source is ES modules with JSDoc types checked by `tsc`.

## Adding a rule

1. Find the group: `src/rules/text-tools.js` (sed/grep/find/awk), `coreutils.js` (flags and long options), `commands.js` (missing commands), `shell.js` (bash version, `sh`).
2. Add the rule. For a table-driven group (missing commands, GNU long options) add one entry.
3. Give it a **probe**: the snippet that breaks (`bad`), the portable replacement (`good`), and the output both should print where they work (`expect`).
4. Run it on a real system:

   ```sh
   node bin/portsh.js verify --rule your-rule-id
   ```

   The probe must pass on your OS. If you can, try another OS or a container (`docker run --rm -v "$PWD:/w" -w /w alpine:3.20 sh -c 'apk add nodejs && node bin/portsh.js verify --rule your-rule-id'`). CI runs macOS, Ubuntu and Alpine.
5. `npm run docs` to regenerate `docs/rules.md`, then `npm run check`.

### Rule guidelines

- **Evidence first.** State where it breaks and where it works. "I remember that macOS lacks X" is not enough; run it.
- **Stay quiet when unsure.** A false positive costs more trust than a false negative.
- **Silent wrong results beat loud errors in importance.** `sed 's/\s/_/'` doing nothing on macOS is worse than a crash.
- **Suggest a fix that is verified**, ideally the `good` probe, which also runs on every platform.
- Do not add rules for tools that are only missing because they are not installed *on your machine* (`jq`, `curl`, `git`); stick to differences between default userlands.

## Reporting a false positive

Open an issue with the rule id, the smallest snippet, and the output of `npx github:Nithinfgs/portsh verify --rule <id>` from the machine where it works.

## Pull requests

Keep changes focused, add or update tests (`test/`), and make sure `npm run check` passes. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`).

By contributing you agree your work is released under the [MIT license](LICENSE).
