/** Pure, server-authoritative presentation state. One turn is not one sentence. */
export function createStandingDisplay({ resolveImage, emit, persist = () => {}, initialCharacter = null, now = Date.now, epoch = 'session' }) {
  let state = { epoch, revision: 0, selectionVersion: 0, characterId: initialCharacter, slotId: 'normal', quietTurns: 0, reason: null, replyVersion: 0 };
  const finished = new Set();
  const clients = new Map();
  let latestTurn = null;
  function snapshot() {
    const image = state.characterId ? resolveImage(state.characterId, state.slotId) : null;
    return { ...state, reason: state.reason, imageUrl: image?.image_url || null, bounds: image?.bounds || null, missingCount: image?.missingCount ?? 0, resolvedSlotId: image?.slot_id || null, imageVersion: image?.version ?? null };
  }
  function publish() { state.revision++; emit(snapshot()); }
  function select(characterId, clientId, sequence) {
    if (clientId && Number.isFinite(sequence)) {
      if (sequence <= (clients.get(clientId) ?? -1)) return snapshot();
      clients.set(clientId, sequence);
      if (clients.size > 1000) clients.delete(clients.keys().next().value);
    }
    characterId = characterId == null ? null : Number(characterId);
    if (state.characterId !== characterId) {
      state = { ...state, characterId, selectionVersion: state.selectionVersion + 1, slotId: 'normal', quietTurns: 0, reason: null };
      latestTurn = null;
      persist(characterId);
      publish();
    }
    return snapshot();
  }
  function begin(characterId, id) {
    const turn = { characterId: Number(characterId), id: String(id), selectionVersion: state.selectionVersion, sticker: false, finished: finished.has(String(id)) };
    if (current(turn) && !turn.finished) latestTurn = turn.id;
    return turn;
  }
  function current(turn) { return turn && turn.characterId === state.characterId && turn.selectionVersion === state.selectionVersion; }
  function expression(turn, slotId) {
    if (!current(turn) || turn.finished || latestTurn !== turn.id) return;
    turn.sticker = true;
    state.slotId = slotId;
    state.quietTurns = 0;
    publish();
  }
  function complete(turn) {
    if (!turn || turn.finished || finished.has(turn.id)) return;
    turn.finished = true;
    finished.add(turn.id);
    if (finished.size > 2000) finished.delete(finished.values().next().value);
    if (!current(turn) || latestTurn !== turn.id) return;
    if (!turn.sticker && state.slotId !== 'normal' && ++state.quietTurns >= 2) {
      state.slotId = 'normal'; state.quietTurns = 0;
    }
    state.replyVersion++;
    publish();
  }
  function reason(turn, text) {
    if (!current(turn) || latestTurn !== turn.id || !text?.trim() || state.reason?.id === turn.id) return;
    state.reason = { id: turn.id, text: text.trim(), createdAt: now() };
    publish();
  }
  return { snapshot, select, begin, expression, complete, reason, refresh: publish };
}
