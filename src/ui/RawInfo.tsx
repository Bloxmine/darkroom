import { metaRows } from '../core/raw/develop';
import { useDoc } from '../store/doc';
import { engine } from '../store/engine';

/** Read-only camera metadata of a RAW Photo node's file (shown under its parameters). */
export function RawMetaBlock({ assetId }: { assetId: string }) {
  useDoc((s) => s.project.assets[assetId]); // re-render when the asset changes
  const a = assetId ? engine?.assets.get(assetId) : undefined;
  if (!assetId) return <div className="pnote">Tip: drop a RAW file (DNG, CR2, CR3, NEF, ARW, RAF…) onto the Node Graph to import it.</div>;
  if (!a?.raw) return <div className="pnote muted">RAW data not loaded — use Browse… to re-import the file.</div>;
  const rows = metaRows(a.raw.meta);
  return (
    <div className="pnote">
      <b>Camera metadata</b>
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
          <tr>
            <td>File</td>
            <td>
              {a.name} · {(a.raw.bytes.byteLength / 1e6).toFixed(1)} MB
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
