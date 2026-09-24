import type { Board, BoardEntityObject } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { useBoardObjects } from './useBoardObjects';

const connectionState = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <ConnectionProvider value={connectionState}>
    <AntApp>{children}</AntApp>
  </ConnectionProvider>
);

const zone = (x: number) => ({ type: 'zone', x, y: 0, width: 400, height: 600, label: 'Z' });

const board = {
  board_id: 'board-1',
  objects: { 'zone-a': zone(0), 'zone-b': zone(1000) },
} as unknown as Board;

function placement(
  objectId: string,
  zoneId: string | null,
  entity: { branch_id?: string; card_id?: string }
): BoardEntityObject {
  return {
    object_id: objectId,
    board_id: 'board-1',
    position: { x: 10, y: 10 },
    zone_id: zoneId,
    ...entity,
  } as unknown as BoardEntityObject;
}

function pinnedCounts(
  boardObjectsForBoard: BoardEntityObject[],
  archived: { branches?: string[]; cards?: string[] } = {}
): Record<string, number> {
  const { result } = renderHook(
    () =>
      useBoardObjects({
        board,
        client: null,
        boardObjectsForBoard,
        archivedBranchIds: new Set(archived.branches ?? []),
        archivedCardIds: new Set(archived.cards ?? []),
        setNodes: vi.fn(),
        deletedObjectsRef: { current: new Set<string>() },
      }),
    { wrapper }
  );
  const counts: Record<string, number> = {};
  for (const node of result.current.getBoardObjectNodes()) {
    counts[node.id] = node.data.pinnedItemCount;
  }
  return counts;
}

describe('useBoardObjects zone pinnedItemCount', () => {
  it('leaves out a board object whose branch is archived', () => {
    const counts = pinnedCounts(
      [
        placement('bo-1', 'zone-a', { branch_id: 'branch-active' }),
        placement('bo-2', 'zone-a', { branch_id: 'branch-archived' }),
      ],
      { branches: ['branch-archived'] }
    );
    expect(counts['zone-a']).toBe(1);
  });

  it('leaves out a board object whose card is archived', () => {
    const counts = pinnedCounts(
      [
        placement('bo-1', 'zone-a', { card_id: 'card-active' }),
        placement('bo-2', 'zone-a', { card_id: 'card-archived' }),
      ],
      { cards: ['card-archived'] }
    );
    expect(counts['zone-a']).toBe(1);
  });

  it('counts active branches and cards in the zone but not objects pinned elsewhere', () => {
    const counts = pinnedCounts(
      [
        placement('bo-1', 'zone-a', { branch_id: 'branch-1' }),
        placement('bo-2', 'zone-a', { card_id: 'card-1' }),
        placement('bo-3', 'zone-b', { branch_id: 'branch-2' }),
        placement('bo-4', 'zone-b', { card_id: 'card-2' }),
        placement('bo-5', 'zone-b', { card_id: 'card-3' }),
        placement('bo-6', null, { branch_id: 'branch-3' }),
      ],
      // An archive on an id with the other entity type must not leak across.
      { branches: ['card-1'], cards: ['branch-1'] }
    );
    expect(counts['zone-a']).toBe(2);
    expect(counts['zone-b']).toBe(3);
  });
});
