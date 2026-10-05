import { compareVersions } from './version.js';

export function shouldUpdate(installed, latest) {
  return compareVersions(latest, installed) > 0;
}
