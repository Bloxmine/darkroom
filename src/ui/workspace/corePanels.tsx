/** The editor's own dockable panels (the file browser registers its `browser.*` panels itself). */
import { useEffect, useRef } from 'react';
import { useUi } from '../../store/ui';
import { useViewer } from '../../store/viewer';
import { Panel } from '../Chrome';
import { GraphEditor } from '../GraphEditor';
import { Icon } from '../Icon';
import { Library } from '../Library';
import { Properties } from '../Properties';
import { Viewer } from '../Viewer';
import { ScopesBody, useScopesPanel } from '../viewer/Scopes';
import { registerPanel } from './panels';
import { isPanelVisible, useWorkspaceStore } from './store';

/** Node graph: re-frames the nodes when panels were rearranged (workspace switch, docking, maximise). */
function GraphPanel() {
  const tick = useWorkspaceStore((s) => s.arrangeTick);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => isPanelVisible('graph') && useUi.setState((s) => ({ fitGraphTick: s.fitGraphTick + 1 })), 90);
    return () => clearTimeout(t);
  }, [tick]);
  return <GraphEditor />;
}

/** Scopes as a workspace panel: turns the scopes on while mounted (and the viewer's inline dock off). */
function ScopesPanel() {
  const on = useViewer((s) => s.scopes);
  useEffect(() => {
    const was = useViewer.getState().scopes;
    useScopesPanel.setState((s) => ({ mounted: s.mounted + 1 }));
    useViewer.setState({ scopes: true });
    return () => {
      useScopesPanel.setState((s) => ({ mounted: s.mounted - 1 }));
      if (!was) useViewer.setState({ scopes: false });
    };
  }, []);
  return (
    <Panel title="Scopes" icon="layer_histogram" className="scopes-panel">
      {on ? (
        <div className="vx-scopes docked dock-scopes" aria-label="Scopes">
          <ScopesBody panel />
        </div>
      ) : (
        <div className="dock-placeholder">
          <Icon name="layer_histogram" size={32} />
          <span className="muted">Scopes are off.</span>
          <button className="btn" onClick={() => useViewer.setState({ scopes: true })}>
            Show Scopes
          </button>
        </div>
      )}
    </Panel>
  );
}

registerPanel({ id: 'library', title: 'Node Library', icon: 'application_side_tree', component: Library, minWidth: 150, group: 'editor' });
registerPanel({ id: 'viewer', title: 'Viewer', icon: 'monitor', component: Viewer, minWidth: 200, minHeight: 120, group: 'editor' });
registerPanel({ id: 'graph', title: 'Node Graph', icon: 'node_design', component: GraphPanel, minWidth: 200, minHeight: 100, group: 'editor' });
registerPanel({ id: 'properties', title: 'Properties', icon: 'application_side_list', component: Properties, minWidth: 200, group: 'editor' });
registerPanel({ id: 'scopes', title: 'Scopes', icon: 'layer_histogram', component: ScopesPanel, minWidth: 180, group: 'editor' });
