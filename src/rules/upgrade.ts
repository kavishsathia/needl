import { checkRule, declarationText } from "./check.js";

/** Removes `#"…"` notes, the per-part readings rules had before the rule sentence, leaving the rule itself unchanged. */
export function stripNotes(source: string): string {
  let output = "";
  let index = 0;
  const skipString = (from: number): number => {
    let at = from + 1;
    while (at < source.length && source[at] !== "\"" && source[at] !== "\n") at += source[at] === "\\" ? 2 : 1;
    return Math.min(at + 1, source.length);
  };
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\"") {
      const end = skipString(index);
      output += source.slice(index, end);
      index = end;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      output += source.slice(index, stop);
      index = stop;
    } else if (character === "#" && source[index + 1] === "\"") {
      index = skipString(index + 1);
      while (source[index] === " " || source[index] === "\t") index += 1;
    } else {
      output += character;
      index += 1;
    }
  }
  return output.split("\n").filter((line) => line.trim().length > 0).join("\n");
}

/**
 * Rewrites a rule saved before inputs were declared and notes were replaced by one sentence: notes are dropped and each
 * `$name` gets the declaration its use implies. The rule logic, and so the compiled monitor, is unchanged. Without a
 * sentence the rule is read word for word. Returns undefined when the source is already current or cannot be upgraded.
 */
export function upgradeRuleSource(source: string): string | undefined {
  if (checkRule(source).ok) return undefined;
  const body = stripNotes(source);
  const loose = checkRule(body, { inferUndeclared: true });
  if (!loose.ok) return undefined;
  const declarations = loose.rule.params.filter((param) => !param.declared).map(declarationText);
  const upgraded = declarations.length === 0 ? body : `${declarations.join("\n")}\n\n${body}`;
  return checkRule(upgraded).ok ? upgraded : undefined;
}
