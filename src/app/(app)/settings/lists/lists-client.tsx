"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type NamedCount = { id: string; name: string; count: number };

export function ListsSegmentsClient({ lists, segments }: { lists: NamedCount[]; segments: NamedCount[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});

  async function renameList(list: NamedCount) {
    const name = prompt(`Rename list "${list.name}" to:`, list.name);
    if (!name?.trim() || name.trim() === list.name) return;
    setBusy(list.id);
    await fetch("/api/venues/lists", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: list.id, name: name.trim() }),
    });
    setBusy(null);
    router.refresh();
  }

  async function deleteList(list: NamedCount) {
    const warning =
      list.count > 0
        ? `Delete list "${list.name}"? Its ${list.count} contact${list.count === 1 ? "" : "s"} will stay in the database, just unassigned from any list. This can't be undone.`
        : `Delete list "${list.name}"?`;
    if (!confirm(warning)) return;
    setBusy(list.id);
    await fetch("/api/venues/lists", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: list.id }),
    });
    setBusy(null);
    router.refresh();
  }

  async function mergeList(list: NamedCount) {
    const targetId = mergeTarget[list.id];
    if (!targetId) return;
    const target = lists.find((l) => l.id === targetId);
    if (!target) return;
    if (
      !confirm(
        `Move all ${list.count} contact${list.count === 1 ? "" : "s"} from "${list.name}" into "${target.name}", then delete "${list.name}"? This can't be undone.`,
      )
    )
      return;
    setBusy(list.id);
    await fetch("/api/venues/lists/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: list.id, targetId }),
    });
    setBusy(null);
    router.refresh();
  }

  async function renameSegment(segment: NamedCount) {
    const name = prompt(`Rename segment "${segment.name}" to:`, segment.name);
    if (!name?.trim() || name.trim() === segment.name) return;
    setBusy(segment.id);
    await fetch("/api/venues/segments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: segment.id, name: name.trim() }),
    });
    setBusy(null);
    router.refresh();
  }

  async function deleteSegment(segment: NamedCount) {
    if (!confirm(`Delete segment "${segment.name}"? Its contacts are unaffected — only the saved selection goes away.`))
      return;
    setBusy(segment.id);
    await fetch("/api/venues/segments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: segment.id }),
    });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="font-display text-[19px] text-ink">Lists</h2>
        <div className="mt-3 flex flex-col gap-2">
          {lists.map((list) => (
            <div
              key={list.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-hairline bg-surface px-4 py-3"
            >
              <div className="text-sm text-ink">
                {list.name} <span className="text-xs text-muted-3">· {list.count} contacts</span>
              </div>
              <div className="flex items-center gap-2.5">
                {lists.length > 1 && (
                  <>
                    <select
                      value={mergeTarget[list.id] ?? ""}
                      onChange={(e) => setMergeTarget((m) => ({ ...m, [list.id]: e.target.value }))}
                      className="border-0 border-b border-rule bg-transparent px-0.5 py-1 text-xs text-ink outline-none"
                    >
                      <option value="">Merge into…</option>
                      {lists
                        .filter((l) => l.id !== list.id)
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                    </select>
                    <button
                      onClick={() => mergeList(list)}
                      disabled={busy !== null || !mergeTarget[list.id]}
                      className="text-xs text-muted-3 hover:text-accent disabled:opacity-50"
                    >
                      Merge
                    </button>
                  </>
                )}
                <button
                  onClick={() => renameList(list)}
                  disabled={busy !== null}
                  className="text-xs text-muted-3 hover:text-accent disabled:opacity-50"
                >
                  Rename
                </button>
                <button
                  onClick={() => deleteList(list)}
                  disabled={busy !== null}
                  className="text-xs text-error hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {lists.length === 0 && <p className="text-sm text-muted-3">No lists yet — import contacts to create one.</p>}
        </div>
      </section>

      <section>
        <h2 className="font-display text-[19px] text-ink">Segments</h2>
        <div className="mt-3 flex flex-col gap-2">
          {segments.map((segment) => (
            <div
              key={segment.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-hairline bg-surface px-4 py-3"
            >
              <div className="text-sm text-ink">
                {segment.name} <span className="text-xs text-muted-3">· {segment.count} contacts</span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => renameSegment(segment)}
                  disabled={busy !== null}
                  className="text-xs text-muted-3 hover:text-accent disabled:opacity-50"
                >
                  Rename
                </button>
                <button
                  onClick={() => deleteSegment(segment)}
                  disabled={busy !== null}
                  className="text-xs text-error hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {segments.length === 0 && (
            <p className="text-sm text-muted-3">No segments yet — save a selection from the Venues page.</p>
          )}
        </div>
      </section>
    </div>
  );
}
