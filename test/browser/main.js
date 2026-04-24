import { describe, it, assert } from '@netflix/x-test/x-test.js';
import { add, sign } from './subject.js';

describe('test suite', () => {
  it('test 123', () => {
    assert(true);
  });
  it('add', () => {
    assert(add(1, 2) === 3);
  });
  it('sign covers the positive branch', () => {
    assert(sign(5) === 1);
    // The negative and zero branches of `sign` are intentionally uncovered
    //  so the coverage report has something non-trivial to report.
  });
});
