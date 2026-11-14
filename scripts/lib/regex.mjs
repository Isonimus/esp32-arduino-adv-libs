// Escape a string for literal use inside a RegExp. One definition, because an open-coded character
// class is easy to get subtly wrong: a miswritten class that closes early escapes nothing and silently
// matches the wrong thing (slice-0012 adversarial review found exactly that in two copies). The class
// covers every ECMAScript regex metacharacter, including the closing bracket and the backslash.
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
