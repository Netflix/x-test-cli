/**
 * Strip common leading indentation from a tagged template literal.
 *
 * The trailing-newline convention follows the backtick position in the
 * template:
 *
 *   dedent`           dedent`
 *     line1             line1
 *     line2             line2`
 *   `
 *
 *   → "line1\nline2\n"  → "line1\nline2"
 *
 * When the closing backtick sits on its own indented line (the common
 * multi-line form), the result ends in `\n` — matches line-oriented text
 * files, matches the per-line `\n` the reporter writes to its stream.
 * When the backtick sits right after the final content character, the
 * result has no trailing `\n` — useful when comparing against producers
 * that return newline-joined-without-trailer (e.g. `array.join('\n')`).
 *
 * The heuristic: if the raw template ends with a whitespace-only line,
 * include a trailing `\n`; otherwise don't.
 */
export function dedent(strings, ...values) {
  let raw = strings[0];
  for (let index = 0; index < values.length; index++) {
    raw += String(values[index]) + strings[index + 1];
  }
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  let trailing = '';
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
    trailing = '\n';
  }
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[0].length ?? 0;
    if (indent < minIndent) {
      minIndent = indent;
    }
  }
  const stripped = (minIndent > 0 && minIndent < Infinity)
    ? lines.map(line => line.slice(minIndent))
    : lines;
  return stripped.join('\n') + trailing;
}
