import { bzpAdapter } from "./bzp/adapter.js";
import type { SourceAdapter } from "./types.js";

/**
 * Every source adapter, by sourceId. One entry per supported source. The
 * notice type is erased here: callers must only pass an adapter's normalize()
 * what that same adapter's extract() returned (previewSource does).
 */
export const sourceAdapters: ReadonlyMap<string, SourceAdapter> = new Map<string, SourceAdapter>([
  [bzpAdapter.sourceId, bzpAdapter],
]);
