// Dev-only coverage config for this repo’s integration test.
export default {
  coverageTargets: {
    // Dummy module under test — imported by `test/browser/main.js`,
    //  exercised partially so the summary shows a meaningful number.
    './test/browser/subject.js': { lines: 50 },
  },
};
