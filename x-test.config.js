// Dev-only config for this repo’s integration test. The `test:browser:*`
//  scripts in package.json only override `--client`; everything else lives
//  here so the two scripts stay symmetric and short.
export default {
  url:      'http://127.0.0.1:8080/test/browser/',
  browser:  'chromium',
  coverage: true,
  coverageGoals: {
    // Dummy module under test — imported by `test/browser/main.js`,
    //  exercised partially so the summary shows a meaningful number.
    './test/browser/subject.js':  { lines: 50 },
    // Linked stylesheet — applied via `<link>` in index.html. One rule
    //  matches the page's `<h1>`, one does not. Comment-only lines are
    //  stripped from the denominator (see `#cssCommentMask`), so the
    //  natural shape is "matched-rule lines / all-rule lines" = 50%.
    './test/browser/index.css':   { lines: 50 },
  },
};
