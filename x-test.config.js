// Dev-only coverage config for this repo’s integration test.
export default {
  coverageGoals: {
    // Dummy module under test — imported by `test/browser/main.js`,
    //  exercised partially so the summary shows a meaningful number.
    './test/browser/subject.js':  { lines: 50 },
    // Linked stylesheet — applied via `<link>` in index.html. One rule
    //  matches the page's `<h1>`, one does not. Comment-only lines are
    //  stripped from the denominator (see `#cssCommentMask`), so the
    //  natural shape is "matched-rule lines / all-rule lines" = 50%.
    './test/browser/index.css':   { lines: 50 },
    // CSS module script — imported with `type: 'css'` and adopted onto
    //  the document by subject.js. Same partial-coverage shape.
    './test/browser/subject.css': { lines: 50 },
  },
};
