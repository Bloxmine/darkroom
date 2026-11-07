/** Small shared helpers of the graph editor (kept out of component modules for Fast Refresh). */

/** Colour tags (node headers, frames): palette names map to theme CSS variables; anything else is a CSS colour. */
export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'] as const;
export const tagColor = (c: string) => ((TAG_COLORS as readonly string[]).includes(c) ? `var(--tag-${c})` : c);

/** React Flow ids of frames are kept apart from graph node ids. */
export const FRAME_PREFIX = 'fr:';
export const frameRfId = (id: string) => FRAME_PREFIX + id;
export const isFrameRfId = (id: string) => id.startsWith(FRAME_PREFIX);
export const frameIdOf = (rfId: string) => rfId.slice(FRAME_PREFIX.length);
