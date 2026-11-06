import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { clike } from '@codemirror/legacy-modes/mode/clike';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const words = (s: string) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((w) => [w, true]));

/** GLSL ES 3.00 + Darkroom's shader library, as a CodeMirror legacy clike mode. */
const glsl = clike({
  name: 'glsl',
  keywords: words(
    'const uniform in out inout centroid flat smooth layout precision highp mediump lowp invariant ' +
      'break continue discard return for while do if else switch case default struct sampler2D sampler3D samplerCube isampler2D usampler2D',
  ),
  types: words('float int uint bool void vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 mat2x3 mat3x2'),
  blockKeywords: words('for while do if else switch struct'),
  builtin: words(
    'radians degrees sin cos tan asin acos atan sinh cosh tanh pow exp log exp2 log2 sqrt inversesqrt abs sign floor ceil trunc round fract mod modf ' +
      'min max clamp mix step smoothstep isnan isinf length distance dot cross normalize reflect refract lessThan lessThanEqual greaterThan ' +
      'greaterThanEqual equal notEqual any all not texture textureLod textureSize texelFetch textureGrad dFdx dFdy fwidth ' +
      // Darkroom library (core/glsl.ts)
      'luma luma601 saturate srgbToLinear linearToSrgb rgb2yiq yiq2rgb rgb2yuv yuv2rgb rgb2ycbcr ycbcr2rgb rgb2hsv hsv2rgb rgb2hsl hsl2rgb ' +
      'kelvinToRgb hash11 hash12 hash22 hash32 hash13 gaussRand valueNoise gradNoise fbm blendMultiply blendScreen blendOverlay blendSoftLight ' +
      'blendHardLight blendColorDodge blendColorBurn blendLinearLight texClamp texel pixelCoord',
  ),
  atoms: words('true false PI TAU v_uv fragColor gl_FragCoord u_resolution u_scale u_time u_iteration u_prev u_prev_size'),
  indentSwitch: false,
  hooks: {
    '#': (stream: { skipToEnd: () => void }) => {
      stream.skipToEnd();
      return 'meta';
    },
  },
});

/** Colours only from the theme's CSS custom properties. */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--sel)', fontWeight: 'bold' },
  { tag: [t.typeName, t.className], color: 'color-mix(in srgb, var(--sel) 70%, var(--text))' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom], color: 'color-mix(in srgb, var(--error) 75%, var(--text))' },
  { tag: [t.standard(t.variableName), t.function(t.variableName)], color: 'color-mix(in srgb, var(--sel) 45%, var(--error))' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--muted)' },
  { tag: t.string, color: 'var(--error)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', background: 'var(--field)', color: 'var(--text)', fontSize: '11px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.45' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { background: 'var(--face-2, var(--face))', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--hover) 35%, transparent)' },
  '.cm-activeLineGutter': { background: 'var(--hover)', color: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'color-mix(in srgb, var(--sel) 30%, transparent) !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-matchingBracket': { background: 'color-mix(in srgb, var(--sel) 25%, transparent)', outline: '1px solid var(--sel)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--error)' },
  '.cm-tooltip': { background: 'var(--face)', color: 'var(--text)', border: '1px solid var(--lo)', fontFamily: 'var(--font)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
});

export interface EditorDiagnostic {
  /** 1-based line. */
  line: number;
  message: string;
  severity?: 'error' | 'warning';
}

/** A CodeMirror 6 GLSL editor. Uncontrolled after mount; `value` changes from outside replace the doc. */
export function GlslEditor({ value, onChange, diagnostics, className }: { value: string; onChange: (v: string) => void; diagnostics?: EditorDiagnostic[]; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          lintGutter(),
          StreamLanguage.define(glsl),
          syntaxHighlighting(highlight),
          theme,
          EditorState.tabSize.of(2),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const ds: Diagnostic[] = (diagnostics ?? []).map((d) => {
      const ln = doc.line(Math.max(1, Math.min(doc.lines, d.line)));
      return { from: ln.from, to: Math.max(ln.from, ln.to), severity: d.severity ?? 'error', message: d.message };
    });
    v.dispatch(setDiagnostics(v.state, ds));
  }, [diagnostics, value]);

  return <div ref={host} className={'glsl-editor sunken' + (className ? ' ' + className : '')} />;
}
