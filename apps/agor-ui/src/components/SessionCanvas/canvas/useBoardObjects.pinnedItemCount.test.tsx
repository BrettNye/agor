import type { Board, BoardEntityObject, Branch, CardWithType } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { branchPatched, cardPatched } from '../../../store/agorRealtimeActions';
import { agorStore } from '../../../store/agorStore';
import { archivedBranchIdsKey, archivedCardIdsKey, idSetFromKey } from './archivedPlacements';
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

const branch = (branchId: string, archived = false) =>
  ({ branch_id: branchId, name: branchId, archived }) as unknown as Branch;
const card = (cardId: string, archived = false) =>
  ({ card_id: cardId, title: cardId, archived }) as unknown as CardWithType;

/** Seed the real store with an initial load of the given active branches/cards. */
function hydrate(branchIds: string[], cardIds: string[]) {
  const store = agorStore.getState();
  store.setMap('branchById', new Map(branchIds.map((id) => [id, branch(id)])));
  store.setMap('cardById', new Map(cardIds.map((id) => [id, card(id)])));
  store.setLoading(false);
}

/**
 * Zone pinned-item counts, with archive state derived from the live store the
 * same way SessionCanvas derives it before passing it to useBoardObjects.
 */
function pinnedCounts(boardObjectsForBoard: BoardEntityObject[]): Record<string, number> {
  const { branchById, cardById, loading } = agorStore.getState();
  const placedBranchIds = boardObjectsForBoard.flatMap((o) => (o.branch_id ? [o.branch_id] : []));
  const placedCardIds = boardObjectsForBoard.flatMap((o) => (o.card_id ? [o.card_id] : []));
  const archivedBranchIds = idSetFromKey(
    archivedBranchIdsKey(placedBranchIds, branchById, loading)
  );
  const archivedCardIds = idSetFromKey(archivedCardIdsKey(placedCardIds, cardById));

  const { result } = renderHook(
    () =>
      useBoardObjects({
        board,
        client: null,
        boardObjectsForBoard,
        archivedBranchIds,
        archivedCardIds,
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
  beforeEach(() => {
    agorStore.getState().reset();
  });

  it('leaves out a board object whose branch is archived', () => {
    hydrate(['branch-active', 'branch-archived'], []);
    const boardObjects = [
      placement('bo-1', 'zone-a', { branch_id: 'branch-active' }),
      placement('bo-2', 'zone-a', { branch_id: 'branch-archived' }),
    ];
    expect(pinnedCounts(boardObjects)['zone-a']).toBe(2);

    // Archive through the realtime handler: the store evicts the branch but the
    // board_objects row (zone_id included) stays for in-place unarchive.
    branchPatched(branch('branch-archived', true));
    expect(agorStore.getState().branchById.has('branch-archived')).toBe(false);
    expect(pinnedCounts(boardObjects)['zone-a']).toBe(1);

    // Unarchive restores it to the count.
    branchPatched(branch('branch-archived', false));
    expect(pinnedCounts(boardObjects)['zone-a']).toBe(2);
  });

  it('leaves out a board object whose card is archived', () => {
    hydrate([], ['card-active', 'card-archived']);
    const boardObjects = [
      placement('bo-1', 'zone-a', { card_id: 'card-active' }),
      placement('bo-2', 'zone-a', { card_id: 'card-archived' }),
    ];
    expect(pinnedCounts(boardObjects)['zone-a']).toBe(2);

    cardPatched(card('card-archived', true));
    expect(pinnedCounts(boardObjects)['zone-a']).toBe(1);
  });

  it('counts active branches and cards in the zone but not objects pinned elsewhere', () => {
    hydrate(['branch-1', 'branch-2', 'branch-3'], ['card-1', 'card-2', 'card-3']);
    const counts = pinnedCounts([
      placement('bo-1', 'zone-a', { branch_id: 'branch-1' }),
      placement('bo-2', 'zone-a', { card_id: 'card-1' }),
      placement('bo-3', 'zone-b', { branch_id: 'branch-2' }),
      placement('bo-4', 'zone-b', { card_id: 'card-2' }),
      placement('bo-5', 'zone-b', { card_id: 'card-3' }),
      placement('bo-6', null, { branch_id: 'branch-3' }),
    ]);
    expect(counts['zone-a']).toBe(2);
    expect(counts['zone-b']).toBe(3);
  });
});
