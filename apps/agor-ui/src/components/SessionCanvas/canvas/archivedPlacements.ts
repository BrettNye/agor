/**
 * Archived branches/cards keep their board_objects row (zone_id included) so
 * unarchive restores them in place. These helpers collect the archived ones
 * placed on a board so zone pinned-item counts can skip them.
 *
 * Each returns a sorted, newline-joined key rather than a Set so callers can
 * memoize the Set on the key and keep its identity across unrelated branch/card
 * patches.
 */

/**
 * The store never holds an archived branch: hydration queries `archived:
 * false`, and an archive patch evicts the entry from `branchById`. So a branch
 * that is placed on the board but absent from the active map is archived.
 * Until the initial load finishes an absent branch may just be unhydrated, so
 * nothing is reported while `loading`.
 */
export function archivedBranchIdsKey(
  placedBranchIds: Iterable<string>,
  branchById: ReadonlyMap<string, { archived?: boolean }>,
  loading: boolean
): string {
  if (loading) return '';
  const ids: string[] = [];
  for (const branchId of placedBranchIds) {
    const branch = branchById.get(branchId);
    if (!branch || branch.archived) ids.push(branchId);
  }
  return ids.sort().join('\n');
}

/** Cards stay in `cardById` when archived, flagged by `archived`. */
export function archivedCardIdsKey(
  placedCardIds: Iterable<string>,
  cardById: ReadonlyMap<string, { archived?: boolean }>
): string {
  const ids: string[] = [];
  for (const cardId of placedCardIds) {
    if (cardById.get(cardId)?.archived) ids.push(cardId);
  }
  return ids.sort().join('\n');
}

export function idSetFromKey(key: string): ReadonlySet<string> {
  return new Set(key ? key.split('\n') : []);
}
