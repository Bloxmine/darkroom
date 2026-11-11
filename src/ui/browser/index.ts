/**
 * Bridge-style file browser: registers the `browser.*` panels with the workspace system
 * (src/ui/workspace/panels.ts) and the browser commands / Label menu. Imported once from main.tsx.
 * See docs/BROWSER.md.
 */
import './browser.css';
import { registerPanel } from '../workspace/panels';
import { CollectionsPanel } from './Collections';
import { ContentPanel } from './Content';
import { FilmstripPanel } from './Filmstrip';
import { FilterPanel } from './Filter';
import { FavoritesPanel, FoldersPanel } from './Folders';
import { KeywordsPanel } from './Keywords';
import { MetadataPanel } from './Metadata';
import { PreviewPanel } from './Preview';
import './commands';
import * as A from './actions';
import { fsRef, useBrowser } from './store';

registerPanel({ id: 'browser.folders', title: 'Folders', icon: 'folder', component: FoldersPanel, minWidth: 140, group: 'browser' });
registerPanel({ id: 'browser.favorites', title: 'Favorites', icon: 'star', component: FavoritesPanel, minWidth: 140, group: 'browser' });
registerPanel({ id: 'browser.content', title: 'Content', icon: 'images', component: ContentPanel, minWidth: 240, minHeight: 160, group: 'browser' });
registerPanel({ id: 'browser.preview', title: 'Preview', icon: 'picture', component: PreviewPanel, minWidth: 160, minHeight: 120, group: 'browser' });
registerPanel({ id: 'browser.metadata', title: 'Metadata', icon: 'information', component: MetadataPanel, minWidth: 200, group: 'browser' });
registerPanel({ id: 'browser.keywords', title: 'Keywords', icon: 'key', component: KeywordsPanel, minWidth: 160, group: 'browser' });
registerPanel({ id: 'browser.filter', title: 'Filter', icon: 'filter', component: FilterPanel, minWidth: 160, group: 'browser' });
registerPanel({ id: 'browser.collections', title: 'Collections', icon: 'book', component: CollectionsPanel, minWidth: 160, group: 'browser' });
registerPanel({ id: 'browser.filmstrip', title: 'Filmstrip', icon: 'film', component: FilmstripPanel, minWidth: 200, minHeight: 70, group: 'browser' });

export { BrowserHost } from './Host';

// test / console hook (like window.__darkroom)
declare global {
  interface Window {
    __darkroomBrowser?: unknown;
  }
}
if (typeof window !== 'undefined') window.__darkroomBrowser = { store: useBrowser, actions: A, fsRef };
