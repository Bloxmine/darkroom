/**
 * Panel registry: every dockable panel of the workspace system. The editor's own panels are
 * registered in corePanels.tsx; the Bridge-style file browser registers its `browser.*` panels from
 * src/ui/browser/index.ts. A layout may reference a panel that isn't registered (yet): the dock
 * shows a "Panel not available" placeholder in its place.
 */
import { useSyncExternalStore } from 'react';
import type React from 'react';

export interface PanelDef {
  /** Stable id stored in layouts, e.g. 'viewer', 'browser.content'. */
  id: string;
  /** Tab label. */
  title: string;
  /** FatCow icon name (public/icons/fatcow). */
  icon: string;
  component: React.ComponentType<{ panelId: string }>;
  minWidth?: number;
  minHeight?: number;
  /** Groups the Window menu's panel list. */
  group?: 'editor' | 'browser';
}

const defs = new Map<string, PanelDef>();
const listeners = new Set<() => void>();
let snapshot: PanelDef[] = [];

/** Add (or replace) a panel. Layouts that reference its id pick it up immediately. */
export function registerPanel(def: PanelDef): void {
  defs.set(def.id, def);
  snapshot = [...defs.values()];
  listeners.forEach((f) => f());
}

export function listPanels(): PanelDef[] {
  return snapshot;
}

export function getPanel(id: string): PanelDef | undefined {
  return defs.get(id);
}

export function subscribePanels(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

/** All registered panels; re-renders when one is registered. */
export function usePanels(): PanelDef[] {
  return useSyncExternalStore(subscribePanels, listPanels, listPanels);
}

/** Display title for an id, also for panels that aren't registered (yet). */
export function panelTitle(id: string): string {
  const d = defs.get(id);
  if (d) return d.title;
  const tail = id.split('.').pop() ?? id;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}
