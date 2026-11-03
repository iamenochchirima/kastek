import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, convertToExcalidrawElements, exportToBlob, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { makeBoard } from './scene.js';
import firstBoard from './kasitek-agent-system.excalidraw';
import secondBoard from './kasitek-agent-system-v2.excalidraw';

// New source revisions never overwrite a user's saved older canvas.
const requestedRevision = new URLSearchParams(location.search).get('draft');
const revision = requestedRevision === '1' ? 1 : requestedRevision === '2' ? 2 : 3;
const previous = revision < 3;
const keys = { 1: 'kasitek-shared-agent-target-excalidraw-v1', 2: 'kasitek-shared-agent-target-excalidraw-v2-reviewed-b', 3: 'kasitek-shared-agent-target-excalidraw-v3-context' };
const key = keys[revision];
const initial = (async () => {
  // Measure labels with their actual font before Excalidraw creates text bounds.
  const font = new FontFace('Virgil', 'url(./assets/fonts/Virgil/Virgil-Regular.woff2)');
  await font.load(); document.fonts.add(font);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* Export remains available without browser storage. */ }
  if (saved) return previous ? saved : { ...saved, elements: restoreElements(saved.elements, null, { refreshDimensions: true, repairBindings: true }) };
  return {
    elements: revision === 1 ? firstBoard.elements : revision === 2 ? secondBoard.elements : convertToExcalidrawElements(makeBoard().elements, { regenerateIds: false }),
    appState: { theme: 'light', viewBackgroundColor: '#fffdf8', currentItemFontFamily: 1 },
  };
})();

function download(name, blob) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function App() {
  const initialView = revision === 3 ? 'context' : 'overview';
  const [api, setApi] = useState(null), [view, setView] = useState(initialView);
  const [status, setStatus] = useState('Target architecture under review');
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState(null);
  const timer = useRef(null), previewRegion = useRef(null), focused = useRef(false);
  const views = [['overview', 'Whole system'], ['runtime', 'Inside the runtime'], ['delegation', 'Agent delegation'], ...(revision >= 2 ? [['contracts', 'Failure contracts']] : []), ...(revision === 3 ? [['context', 'Context management']] : [])];

  const subset = (name = view) => {
    const all = api?.getSceneElements() || [];
    const ids = new Set(all.filter(element => element.customData?.scene === name).map(element => element.id));
    return all.filter(element => ids.has(element.id) || element.containerId && ids.has(element.containerId));
  };
  const focus = name => {
    setView(name);
    const selected = subset(name);
    if (selected.length) api.scrollToContent(selected, { fitToContent: true, viewportZoomFactor: .86 });
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (preview) previewRegion.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [preview]);

  const save = (elements, state, files) => {
    if (api && elements.length && !focused.current) {
      focused.current = true;
      requestAnimationFrame(() => api.scrollToContent(subset(initialView), { fitToContent: true, viewportZoomFactor: .86 }));
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({ elements, appState: { theme: state.theme,
          viewBackgroundColor: state.viewBackgroundColor, scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom }, files }));
        setStatus(`Revision ${revision} saved in this browser`);
      } catch { setStatus('Export to keep your changes; browser storage is unavailable'); }
    }, 500);
  };
  const sceneJson = () => serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local');
  const exportImage = () => exportToBlob({ elements: subset(), files: api.getFiles(),
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: '#fffdf8', exportWithDarkMode: false }, exportPadding: 40 });
  const png = async () => {
    if (!api || busy) return;
    setBusy(true);
    try { download(`agent-system-v${revision}-${view}.png`, await exportImage()); }
    catch { setStatus('PNG export failed. The editable drawing is still available.'); }
    finally { setBusy(false); }
  };
  const preparePreview = async () => {
    if (!api || busy) return;
    setBusy(true);
    try {
      const blob = await exportImage();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      setPreview({ view, json: sceneJson(), image: dataUrl });
    } catch { setStatus('Preview failed. Save the editable drawing to keep your changes.'); }
    finally { setBusy(false); }
  };

  return <>
    <header>
      <div><strong>Shared agent system</strong><span>Revision {revision} · Target architecture under review</span></div>
      <nav aria-label="Architecture views">{views.map(([name, label]) => <button key={name} className={view === name ? 'selected' : ''} onClick={() => focus(name)}>{label}</button>)}</nav>
      <div className="actions">
        {revision !== 3 && <a href="?v=3-context">Revision 3</a>}
        {revision !== 2 && <a href="?draft=2&v=3-context">Revision 2</a>}
        {revision !== 1 && <a href="?draft=1&v=3-context">Revision 1</a>}
        <button disabled={!api} onClick={() => download(`kasitek-agent-system-v${revision}.excalidraw`, new Blob([sceneJson()], { type: 'application/json' }))}>Save .excalidraw</button>
        <button disabled={!api || busy} onClick={png}>{busy ? 'Preparing…' : 'Export PNG'}</button>
        <button disabled={!api || busy} onClick={preparePreview}>Preview export</button>
      </div>
    </header>
    <main><Excalidraw excalidrawAPI={setApi} initialData={initial} onChange={save}
      UIOptions={{ canvasActions: { loadScene: true, export: { saveFileToDisk: true }, saveAsImage: true } }} /></main>
    <footer><span role="status">{status}</span><span>Purple: shared runtime · Amber: configuration · Blue: product authority · Green: scoped data</span><span>Design proposals; agent runtime unchanged.</span></footer>
    {preview && <section ref={previewRegion} className="export-preview" aria-label="Export preview">
      <div><h2>Revision {revision} · {views.find(([name]) => name === preview.view)?.[1]}</h2><button onClick={() => setPreview(null)}>Close preview</button></div>
      <img alt="Prepared architecture PNG" src={preview.image} />
      <details><summary>Editable drawing JSON</summary><label htmlFor="scene-json">Excalidraw JSON</label><textarea id="scene-json" readOnly value={preview.json} /></details>
    </section>}
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
