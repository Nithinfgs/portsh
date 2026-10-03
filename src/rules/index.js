import { commandRules } from './commands.js';
import { coreutilsRules } from './coreutils.js';
import { shellRules } from './shell.js';
import { textToolRules } from './text-tools.js';

/** @typedef {import('./helpers.js').Rule} Rule */

/** @type {readonly Rule[]} */
export const RULES = [...textToolRules, ...coreutilsRules, ...shellRules, ...commandRules];

/** @type {Map<string, Rule>} */
export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** @type {Map<string, Rule[]>} rules indexed by the command name they inspect */
export const RULES_BY_COMMAND = new Map();
/** @type {Rule[]} rules that inspect every command */
export const WILDCARD_RULES = [];

for (const rule of RULES) {
  for (const name of rule.commands) {
    if (name === '*') {
      WILDCARD_RULES.push(rule);
      continue;
    }
    const list = RULES_BY_COMMAND.get(name);
    if (list) list.push(rule);
    else RULES_BY_COMMAND.set(name, [rule]);
  }
}
