/**
 * Panels keep their React state (and the viewer its WebGL canvas, the graph its React Flow
 * instance) while they move between docks: each panel is rendered ONCE, through a portal, into a
 * persistent element created here. Dock stacks just re-parent that element into their body
 * (Dock.tsx), so moving a tab or switching workspace never remounts the panel.
 */
import { createContext, useContext } from 'react';
import { create } from 'zustand';

const els = new Map<string, HTMLDivElement>();

/** The persistent host element of a panel. */
export function panelElement(id: string): HTMLDivElement {
  let e = els.get(id);
  if (!e) {
    e = document.createElement('div');
    e.className = 'dock-panel';
    e.dataset.panel = id;
    els.set(id, e);
  }
  return e;
}

export interface Placement {
  /** Slot in the stack's tab bar for the panel's header tools (null: tab not active). */
  tools: HTMLElement | null;
  active: boolean;
}

/** Where each panel currently sits (written by the stacks). */
export const usePlacement = create<Record<string, Placement>>(() => ({}));

export interface DockContext extends Placement {
  panelId: string;
  title: string;
}

/** Set for panel components rendered inside the dock (Chrome.tsx `Panel` uses it). */
export const DockCtx = createContext<DockContext | null>(null);
export const useDock = () => useContext(DockCtx);
