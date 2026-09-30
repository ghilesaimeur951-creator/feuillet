import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests on the production build, in Chromium with a simulated camera
 * (tests/fixtures/e2e/document.mjpeg converted to Y4M by the global setup).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    permissions: ['camera', 'clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  },
  webServer: {
    command: 'PORT=4174 bun scripts/serve.ts dist',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          // UTF-8 locale so that accented download names are kept (the C locale turns them into "download").
          env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=tests/e2e/.artifacts/document.y4m'],
        },
      },
    },
  ],
});
