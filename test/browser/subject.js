// Minimal module under test — exists only so the integration test has
//  something to exercise for coverage purposes. Keep tiny and stable.

export function add(a, b) {
  return a + b;
}

// `disable` / `enable` brackets — the whole `subtract` function is omitted
//  from the coverage report. In VSCode Coverage Gutters, these lines show
//  no gutter mark at all (not green, not red — simply not measured).
/* x-test:coverage disable */
export function subtract(a, b) {
  return a - b;
}
/* x-test:coverage enable */

export function sign(n) {
  if (n > 0) {
    return 1;
  }
  if (n < 0) {
    // `ignore next` — only the single line immediately below is dropped
    //  from the report, even though surrounding sign() branches count.
    /* x-test:coverage ignore next */
    return -1;
  }
  return 0;
}

// `ignore next 3` — the next three non-pragma lines (declaration, body,
//  closing brace) are dropped from the report, so `notUsed` contributes
//  nothing to coverage even though it's never called.
/* x-test:coverage ignore next 3 */
export function notUsed() {
  // Coverage tool should report this as unused.
}
