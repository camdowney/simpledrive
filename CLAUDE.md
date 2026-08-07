# SimpleDrive

## Vendor code

- Never modify files under `web/static/vendor/` (third-party libraries). To change
  vendored library behavior, override it from our own code (`web/static/js/`,
  `web/static/css/`) instead.

## Code style

### Comments

- Comment only when the _why_ is non-obvious (a workaround, quirk, or
  constraint); never narrate _what_ the code does. Prefer self-explanatory code.
- A whole comment (total text, not per line) must be 100 characters or fewer
  unless absolutely necessary — keep it to one terse line, shortening the
  wording rather than wrapping across lines. Applies to all files, Go included.

### CSS (`web/static/css/style.css`)

- Keep all rules for a given element/component localized together. A base rule
  and its variants, states, and responsive `@media` overrides belong in one
  block, not scattered across the file. When you add a media-query override for
  something, place it directly beneath the rule it overrides.
- Don't bundle overrides for multiple elements into one shared `@media` block.
  Give each element its own `@media` block beneath its base rule, even if that
  repeats the same breakpoint — locality wins over deduplication.
