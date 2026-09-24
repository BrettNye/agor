import { createContext } from 'react';
import {
  compositeColorOver,
  getContrastingTextColor,
  resolveBackgroundBaseColor,
} from '../../../utils/theme';

/**
 * The CSS background the board canvas is actually painted with: the board's
 * own `background_color`, or the theme default the canvas falls back to.
 * Undefined outside a board canvas (isolated renders keep the old behavior).
 */
export const BoardCanvasBackgroundContext = createContext<string | undefined>(undefined);

/**
 * Pick a readable zone title color for what is actually on screen.
 *
 * Zone fills are usually translucent, so the visible color is the fill
 * composited over the board background, not the fill alone. Contrasting
 * against the composite keeps the title readable regardless of the viewer's
 * personal theme. Opaque fills (and anything unparseable) defer to
 * `getContrastingTextColor` unchanged.
 */
export const getZoneTitleColor = (
  zoneFill: string,
  boardBackground: string | undefined,
  token: { colorText: string }
): string => {
  const baseColor = boardBackground ? resolveBackgroundBaseColor(boardBackground) : undefined;
  const composited = baseColor ? compositeColorOver(zoneFill, baseColor) : undefined;
  return getContrastingTextColor(composited ?? zoneFill, token);
};
