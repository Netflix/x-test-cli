// Defines a custom element that imports `./component.css` as a CSS
//  module script and adopts it onto its shadow root — the production
//  pattern this harness exists to measure. WebKit doesn't yet support
//  the `with { type: 'css' }` import attribute, so the harness only
//  runs under chromium.

import sheet from './component.css' with { type: 'css' };

class CssCoverageComponent extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    const inner = document.createElement('div');
    inner.className = 'component-host';
    inner.textContent = 'component';
    root.append(inner);
  }
}

customElements.define('css-coverage-component', CssCoverageComponent);
