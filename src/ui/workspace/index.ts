/** Workspace / docking system entry: registers the editor panels and the Window › Workspace commands. */
import './corePanels';
import './commands';

// The Bridge-style file browser registers its `browser.*` panels from src/ui/browser/index.ts (imported
// by main.tsx); until a referenced panel is registered the dock shows a placeholder.

export { DockRoot } from './Dock';
export { WorkspaceDialogs } from './dialogs';
export { WorkspaceSwitcher } from './WorkspaceSwitcher';
export { registerPanel, listPanels, usePanels, type PanelDef } from './panels';
export { setWorkspace, useWorkspace, useWorkspaceStore, openPanel, closePanel, togglePanel, resetWorkspace } from './store';
