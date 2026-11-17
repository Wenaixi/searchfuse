/**
 * The body of the `## <version>` section in a CHANGELOG, trimmed, or null when
 * that version has no section.
 *
 * The heading may be written either way:
 *
 * - `## 3.3.0 - 2026-08-06` (the plain form this project shipped with), or
 * - `## [3.3.0] - 2026-08-06` (the Keep a Changelog 1.1.0 form, where the
 *   brackets carry a per-version compare link).
 *
 * Both must resolve: the changelog is now written in the bracketed form, while
 * older sections and the test literals still use the plain one.
 *
 * Two bugs used to live in the caller's inline regex:
 *   - `version.replace(/\\./g, '\\\\.')` matched "backslash + any char", so the
 *     dots in the version were never escaped and `3.2.4` could match `3x2y4`.
 *   - the lookahead ended at `\Z`, which JavaScript has no notion of, so it was
 *     read as a literal `Z`. Releasing the OLDEST changelog version (nothing
 *     after it, so no following `## `) then failed to match at all.
 */
export function changelogSection(changelog, version) {
  const escaped = version.replace(/\./g, '\\.');
  // Stop at the next `## ` heading or at the true end of the string. `(?![\s\S])`
  // is the end-of-input anchor JavaScript lacks a `\Z` for. The brackets around
  // the version are optional, so both heading styles match.
  //
  // The version must end at a real boundary: right after it comes either the
  // closing bracket, a space, or end of line. Without that constraint the
  // trailing `[^\n]*` swallows the rest of the version, so asking for `0.1`
  // would return the `0.1.0` section.
  const match = changelog.match(
    new RegExp(`^## \\[?${escaped}[\\]\\s][^\\n]*\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm'),
  );
  return match ? match[1].trim() : null;
}
