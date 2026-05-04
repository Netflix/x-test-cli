import { suite, test, assert } from '@netflix/x-test/x-test.js';
import { add, sign } from './subject.js';

suite('test suite', () => {
  test('test 123', () => {
    assert(true);
  });
  test('add', () => {
    assert(add(1, 2) === 3);
  });
  test('sign covers the positive branch', () => {
    assert(sign(5) === 1);
    // The negative and zero branches of `sign` are intentionally uncovered
    //  so the coverage report has something non-trivial to report.
  });
});
