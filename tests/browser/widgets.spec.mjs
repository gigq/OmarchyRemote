import { test, expect } from './fixtures.mjs';
test.use({ locale: 'en-GB' });
const metrics = {
  host: 'test-host',
  cores: 8,
  cpu_percent: 25,
  memory_total: 16 * 1024 ** 3,
  memory_used: 4 * 1024 ** 3,
  disk_total: 1024 ** 4,
  disk_used: 512 * 1024 ** 3,
  rx_bps: 2048,
  tx_bps: 1024,
  uptime: 90000,
  processes: 120,
  temperature: null,
  updated_at: 1789087200,
};
const weather = {
  current: { temperature_2m: 20, weather_code: 0, wind_speed_10m: 10 },
  daily: { temperature_2m_max: [23], temperature_2m_min: [12] },
  hourly: {
    time: Array.from({ length: 6 }, (_, i) => 1789087200 + i * 3600),
    temperature_2m: [20, 21, 22, 23, 20, 19],
  },
  timezone: 'America/Chicago',
  fetched_at: 1789087200,
};
test('clock advances, widgets show host data, and weather location/units persist', async ({
  page: p,
}) => {
  await p.clock.install({ time: new Date('2026-09-10T19:20:00Z') });
  await p.route('**/api/widgets', r =>
    r.fulfill({
      json: {
        metrics,
        tailscale: {
          host: 'test-host',
          state: 'Running',
          ip: '100.1.2.3',
          magic_dns: true,
          peers: [{ name: 'test-peer', online: true }],
        },
      },
    })
  );
  await p.route('**/api/widgets/cities?*', r =>
    r.fulfill({
      json: {
        results: [
          {
            name: 'Chicago',
            admin1: 'Illinois',
            country: 'United States',
            latitude: 41.85,
            longitude: -87.65,
          },
        ],
      },
    })
  );
  await p.route('**/api/widgets/weather?*', r => r.fulfill({ json: weather }));
  await p.goto('/native/');
  await expect(p.locator('#widget-metrics')).toContainText('test-host');
  await expect(p.locator('#widget-metrics')).toContainText('25%');
  await expect(p.locator('#widget-tailscale')).toContainText('test-peer');
  const time = await p.locator('[data-live-time]').first().textContent();
  await p.clock.runFor(61000);
  await expect(p.locator('[data-live-time]').first()).not.toHaveText(time);
  await p.getByRole('button', { name: 'Choose city', exact: true }).click();
  await p.getByRole('textbox', { name: 'City name' }).fill('Chicago');
  await p.getByRole('button', { name: 'Search', exact: true }).click();
  await p.getByRole('button', { name: 'Chicago, Illinois, United States', exact: true }).click();
  await expect(p.locator('#widget-weather')).toContainText('20°');
  await p.getByRole('button', { name: '°C', exact: true }).click();
  await expect(p.locator('#widget-weather')).toContainText('68°');
  await p.screenshot({ path: 'artifacts/browser/widgets-weather.png' });
  await p.reload();
  await expect(p.locator('#widget-weather')).toContainText('Chicago');
  await expect(p.locator('#widget-weather')).toContainText('68°');
  await p.route('**/api/widgets', r => r.abort());
  await p.clock.runFor(3100);
  await expect(p.locator('#widget-metrics')).toContainText('unavailable');
  await expect(p.locator('#widget-metrics')).not.toContainText('25%');
});

test('phone location uses coordinates, defaults to locale units, and keeps city search after denial', async ({
  page: p,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 41.85003, longitude: -87.65005 });
  await p.route('**/api/widgets', r =>
    r.fulfill({ json: { metrics, tailscale: { state: 'Running', peers: [] } } })
  );
  const requests = [];
  await p.route('**/api/widgets/weather?*', r => {
    requests.push(r.request().url());
    return r.fulfill({ json: weather });
  });
  await p.goto('/native/');
  // Exercise the PWA path: native builds use their own permission-aware bridge.
  await p.evaluate(() => (window.__HYPRLAND_NATIVE__ = false));
  await p.getByRole('button', { name: 'Choose city', exact: true }).click();
  await p.getByRole('button', { name: 'Use phone location', exact: true }).click();
  await expect(p.locator('#widget-weather')).toContainText('Current location');
  await expect(p.locator('#widget-weather')).toContainText('20°');
  expect(requests[0]).toContain('lat=41.85&lon=-87.65');
  await p.getByRole('button', { name: 'Change city', exact: true }).click();
  await expect(p.getByRole('combobox', { name: 'Temperature units' })).toHaveValue('auto');
  await p.getByRole('combobox', { name: 'Temperature units' }).selectOption('f');
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(p.locator('#widget-weather')).toContainText('68°');
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) },
    });
  });
  await p.getByRole('button', { name: 'Change city', exact: true }).click();
  await p.getByRole('button', { name: 'Use phone location', exact: true }).click();
  await expect(p.locator('.weather-results')).toContainText('Location access is off');
  await expect(p.getByRole('textbox', { name: 'City name' })).toBeVisible();
});
test('native temperature preference overrides browser region in automatic mode', async ({
  page: p,
}) => {
  await p.addInitScript(() => {
    window.webkit = {
      messageHandlers: {
        weatherDevice: { postMessage: async () => ({ unit: 'f', locale: 'en_US' }) },
      },
    };
  });
  await p.route('**/api/widgets', r =>
    r.fulfill({ json: { metrics, tailscale: { state: 'Running', peers: [] } } })
  );
  await p.goto('/native/');
  await p.getByRole('button', { name: 'Choose city', exact: true }).click();
  await expect(p.getByRole('combobox', { name: 'Temperature units' })).toContainText(
    'Automatic (°F)'
  );
});
test('a saved phone location keeps its forecast when the device declines a silent refresh, and a restored backup applies live', async ({
  page: p,
}) => {
  await p.addInitScript(() => {
    // The native bridge answers silent refreshes like iOS does before access is granted.
    window.webkit = {
      messageHandlers: {
        weatherDevice: {
          postMessage: async body => {
            if (body.action === 'locale') return { unit: 'c', locale: 'en_GB' };
            if (!body.requestPermission)
              throw Error('Tap Use phone location to allow location access.');
            return { lat: 30.33, lon: -97.96, name: 'Lakeway' };
          },
        },
      },
    };
    localStorage.setItem(
      'omarchy-weather-location',
      JSON.stringify({
        name: 'Lakeway',
        lat: 30.33,
        lon: -97.96,
        source: 'phone',
        locatedAt: Date.now() - 3600000,
      })
    );
  });
  await p.route('**/api/widgets', r =>
    r.fulfill({ json: { metrics, tailscale: { state: 'Running', peers: [] } } })
  );
  const requests = [];
  await p.route('**/api/widgets/weather?*', r => {
    requests.push(r.request().url());
    return r.fulfill({ json: weather });
  });
  await p.goto('/native/');
  await expect(p.locator('#widget-weather')).toContainText('Lakeway');
  await expect(p.locator('#widget-weather')).toContainText('20°');
  await expect(p.locator('#widget-weather')).not.toContainText('Tap Use phone location');
  expect(requests[0]).toContain('lat=30.33&lon=-97.96');
  // persistence.js writes a restored host backup straight into storage.
  await p.evaluate(() =>
    HyprlandUtil.storage.write('omarchy-weather-location', {
      name: 'Chicago',
      lat: 41.85,
      lon: -87.65,
      source: 'city',
    })
  );
  await expect(p.locator('#widget-weather')).toContainText('Chicago');
  await expect.poll(() => requests.at(-1)).toContain('lat=41.85&lon=-87.65');
  await p.evaluate(() => HyprlandUtil.storage.write('omarchy-weather-unit-mode', 'f'));
  await expect(p.locator('#widget-weather')).toContainText('68°');
});
