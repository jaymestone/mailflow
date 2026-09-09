import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { searchContacts } from "./searchContacts";

// Minimal stand-in covering just the query shapes this file's
// clicked_label path actually uses: contacts (id list), link_tokens
// (select + ilike), link_clicks (select + eq + in). Each table's rows are
// supplied directly by the test rather than modeling the full chainable
// builder, since the two clicked_label queries never combine more than
// one filter each.
function mockSupabase(tables: {
  contacts?: { id: string }[];
  link_tokens?: { token: string; contact_id: string; label: string }[];
  link_clicks?: { token: string; is_likely_bot: boolean }[];
}): SupabaseClient {
  function builder(table: string) {
    const rows = (tables as Record<string, unknown[] | undefined>)[table] ?? [];
    const state: {
      ilikeField?: string;
      ilikeValue?: string;
      inField?: string;
      inValues?: unknown[];
      eqFilters: [string, unknown][];
    } = { eqFilters: [] };
    const api = {
      select() {
        return api;
      },
      ilike(field: string, value: string) {
        state.ilikeField = field;
        state.ilikeValue = value.replace(/%/g, "").toLowerCase();
        return api;
      },
      eq(field: string, value: unknown) {
        state.eqFilters.push([field, value]);
        return api;
      },
      in(field: string, values: unknown[]) {
        state.inField = field;
        state.inValues = values;
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      then(resolve: (v: { data: unknown[]; error: null; count: number }) => void) {
        let data = rows;
        if (state.ilikeField) {
          data = data.filter((r) =>
            String((r as Record<string, unknown>)[state.ilikeField!])
              .toLowerCase()
              .includes(state.ilikeValue!),
          );
        }
        for (const [field, value] of state.eqFilters) {
          data = data.filter((r) => (r as Record<string, unknown>)[field] === value);
        }
        if (state.inField) {
          const set = new Set(state.inValues);
          data = data.filter((r) => set.has((r as Record<string, unknown>)[state.inField!]));
        }
        resolve({ data, error: null, count: data.length });
      },
    };
    return api;
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient;
}

describe("searchContacts clicked_label filter", () => {
  it("returns only contacts with a real (non-bot) click on a matching-label link", () => {
    const supabase = mockSupabase({
      contacts: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      link_tokens: [
        { token: "t1", contact_id: "c1", label: "RAKISH" },
        { token: "t2", contact_id: "c2", label: "RAKISH" },
        { token: "t3", contact_id: "c3", label: "KAVITA SHAH" },
      ],
      link_clicks: [
        { token: "t1", is_likely_bot: false }, // c1: real click on Rakish
        { token: "t2", is_likely_bot: true }, // c2: only a bot click on Rakish
        // t3 never clicked at all
      ],
    });

    return searchContacts(supabase, { clicked_label: "rakish" }).then((result) => {
      expect(result.rows.map((r) => r.id)).toEqual(["c1"]);
    });
  });

  it("matches case-insensitively and as a substring", () => {
    const supabase = mockSupabase({
      contacts: [{ id: "c1" }],
      link_tokens: [{ token: "t1", contact_id: "c1", label: "THE LITTLE MERCIES" }],
      link_clicks: [{ token: "t1", is_likely_bot: false }],
    });

    return searchContacts(supabase, { clicked_label: "little mercies" }).then((result) => {
      expect(result.rows.map((r) => r.id)).toEqual(["c1"]);
    });
  });

  it("returns no rows when nobody has clicked a link with that label", () => {
    const supabase = mockSupabase({
      contacts: [{ id: "c1" }],
      link_tokens: [{ token: "t1", contact_id: "c1", label: "RAKISH" }],
      link_clicks: [],
    });

    return searchContacts(supabase, { clicked_label: "samir langus" }).then((result) => {
      expect(result.rows).toEqual([]);
      expect(result.count).toBe(0);
    });
  });
});
