// CSS coverage harness — single test page that renders one
//  `<css-coverage-component>` and **leaves it attached**. Chromium's
//  CSS rule-usage tracker behaves like a live snapshot: it credits a
//  rule as "used" only when a matching element is still attached at
//  `stopCSSCoverage` time. Hygienic per-test fixtures that
//  create-and-remove between assertions un-credit themselves before
//  the run ends and report 0%. Persisting the fixture for the whole
//  run gives the tracker something stable to credit.
//
//  Run this page with `--coverage-goals` to override the project's
//  main goals for a single invocation. See README.md.

import { suite, test, assert } from '@netflix/x-test/x-test.js';
import './component.js';

suite('css coverage harness', () => {
  test('renders <css-coverage-component> with a shadow root (persistent)', () => {
    const element = document.createElement('css-coverage-component');
    document.body.append(element);
    assert(element.shadowRoot !== null);
    assert(element.shadowRoot.querySelector('.component-host') !== null);
    // Intentionally NOT removed — see file header.
  });
});
