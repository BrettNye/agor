// biome-ignore-all lint/plugin/noHardcodedColorLiteral: contrast fixtures need exact physical colors
import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKGROUNDS } from '../../../constants/ui';
import { getContrastingTextColor } from '../../../utils/theme';
import { getZoneTitleColor } from './zoneTitleContrast';

const BLACK = '#000000';
const WHITE = '#ffffff';

// Viewer theme tokens: what getContrastingTextColor falls back to for
// translucent fills, and what the zone title used to follow.
const LIGHT_VIEWER = { colorText: 'rgba(0, 0, 0, 0.88)' };
const DARK_VIEWER = { colorText: 'rgba(255, 255, 255, 0.85)' };
const VIEWERS = [
  ['light', LIGHT_VIEWER],
  ['dark', DARK_VIEWER],
] as const;

// The default new-zone fill and the historical default fills in both themes.
const TRANSLUCENT_FILLS = ['#d9d9d91a', '#ffffff40', '#14141440', 'rgba(22, 119, 255, 0.1)'];

describe('translucent zone fill over a dark board background', () => {
  const DARK_BOARDS = [
    '#0b0e14',
    'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    DEFAULT_BACKGROUNDS.dark,
  ];

  for (const [viewerName, viewer] of VIEWERS) {
    for (const board of DARK_BOARDS) {
      for (const fill of TRANSLUCENT_FILLS) {
        it(`yields light text for a ${viewerName} viewer (fill ${fill}, board ${board.slice(0, 40)})`, () => {
          expect(getZoneTitleColor(fill, board, viewer)).toBe(WHITE);
        });
      }
    }
  }
});

describe('translucent zone fill over a light board background', () => {
  const LIGHT_BOARDS = [
    '#f5f5f5',
    'linear-gradient(180deg, #ffffff 0%, #e6f4ff 100%)',
    DEFAULT_BACKGROUNDS.light,
  ];

  for (const [viewerName, viewer] of VIEWERS) {
    for (const board of LIGHT_BOARDS) {
      for (const fill of TRANSLUCENT_FILLS) {
        it(`yields dark text for a ${viewerName} viewer (fill ${fill}, board ${board.slice(0, 40)})`, () => {
          expect(getZoneTitleColor(fill, board, viewer)).toBe(BLACK);
        });
      }
    }
  }
});

describe('opaque zone fill', () => {
  const OPAQUE_FILLS = [
    '#ffffff',
    '#000000',
    '#1677ff',
    '#fadb14',
    'rgb(82, 196, 26)',
    '#722ed1ff',
  ];
  const BOARDS = [
    undefined,
    '#000000',
    '#ffffff',
    DEFAULT_BACKGROUNDS.dark,
    DEFAULT_BACKGROUNDS.light,
    'url(https://example.com/bg.png)',
  ];

  for (const [viewerName, viewer] of VIEWERS) {
    for (const fill of OPAQUE_FILLS) {
      it(`matches getContrastingTextColor for ${fill} on every board (${viewerName} viewer)`, () => {
        const expected = getContrastingTextColor(fill, viewer);
        for (const board of BOARDS) {
          expect(getZoneTitleColor(fill, board, viewer)).toBe(expected);
        }
      });
    }
  }
});
