/* Packaging supplies machine-specific defaults outside the source tree. */
import fs from 'node:fs';
import { normalize } from './hosts.js';
import { APP_KEY } from './launchers.js';

export function standaloneConfiguration(file) {
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !APP_KEY.test(value?.key || '') ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 80 ||
    /[\x00-\x1f\x7f]/.test(value.name)
  )
    throw new Error('Invalid standalone app configuration');
  return { key: value.key, name: value.name.trim(), host: normalize(value.host) };
}
