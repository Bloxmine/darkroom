import { useSyncExternalStore } from 'react';
import { registryVersion, subscribeRegistry } from '../core/registry';

/** Re-render when nodes/presets/plugins are (un)registered. Returns the registry version. */
export function useRegistry() {
  return useSyncExternalStore(subscribeRegistry, registryVersion);
}
