import { describe, expect, it } from 'vitest';

import { isWindowsChromeFromWsl } from './browser-capture.js';

describe('isWindowsChromeFromWsl', () => {
  it('detects Windows Chrome paths from WSL mounts', () => {
    if (process.platform !== 'linux') {
      expect(isWindowsChromeFromWsl('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')).toBe(
        false,
      );
      return;
    }
    expect(isWindowsChromeFromWsl('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')).toBe(
      true,
    );
    expect(isWindowsChromeFromWsl('/usr/bin/chromium-browser')).toBe(false);
  });
});
