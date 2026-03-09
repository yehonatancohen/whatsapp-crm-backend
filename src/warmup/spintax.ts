/**
 * Spintax Parser Utility
 *
 * Resolves nested Spintax templates like:
 *   "{Hey|Hi|{Yo|Sup}} {bro|man}, {what's up?|how are you?}"
 * into a randomly chosen variation such as:
 *   "Yo bro, how are you?"
 *
 * Algorithm: repeatedly find the innermost {…} group (no nested braces),
 * resolve it, and replace — until no groups remain. This naturally handles
 * arbitrary nesting depth.
 */

/**
 * Resolve a Spintax template string into a single random variation.
 * @param template - A string containing `{option1|option2|...}` groups, possibly nested.
 * @returns A fully resolved string with no remaining `{` or `}` tokens.
 */
export function resolveSpintax(template: string): string {
  // Regex matches the innermost group: `{` followed by non-brace chars, then `}`
  const INNER_GROUP = /\{([^{}]+)\}/;

  let result = template;
  let match = INNER_GROUP.exec(result);

  while (match !== null) {
    const options = match[1].split('|');
    const pick = options[Math.floor(Math.random() * options.length)];
    // Replace only the first occurrence (the one we matched)
    result = result.substring(0, match.index) + pick + result.substring(match.index + match[0].length);
    match = INNER_GROUP.exec(result);
  }

  return result;
}
