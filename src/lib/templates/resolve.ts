export type MergeContact = {
  first_name?: string | null;
  last_name?: string | null;
  venue?: string | null;
  /** Short conversational form of the venue name, when the catalogue name
   * doesn't read well in a sentence. See migration 32. */
  venue_short?: string | null;
  city?: string | null;
  state?: string | null;
  venue_type?: string | null;
};

const MERGE_FIELDS: Record<string, (c: MergeContact) => string> = {
  "first name": (c) => c.first_name?.trim() || "there",
  "last name": (c) => c.last_name?.trim() || "",
  // venue_short wins when set. Deliberately the SAME token rather than a
  // separate {{Venue Short}}: every existing template and campaign then
  // benefits without being edited, and there is no way to author copy that
  // accidentally uses the unreadable form. venue remains the fallback, so
  // the ~98% of names that already read naturally need no short form at all.
  venue: (c) => c.venue_short?.trim() || c.venue?.trim() || "your venue",
  city: (c) => c.city?.trim() || "",
  state: (c) => c.state?.trim() || "",
  "venue type": (c) => c.venue_type?.trim() || "",
};

/** Merge fields ({{First Name}}) are resolved before spintext ({a|b}).
 * Resolving in the other order (as the old N8N workflow did) lets spintext's
 * single-brace regex misparse the inner braces of "{{First Name}}" before
 * the merge step ever sees it. */
export function resolveMergeFields(text: string, contact: MergeContact): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, fieldName: string) => {
    const resolver = MERGE_FIELDS[fieldName.trim().toLowerCase()];
    return resolver ? resolver(contact) : match;
  });
}

export function resolveSpintext(text: string): string {
  // Runs after merge, so any remaining single-brace group is spintext.
  return text.replace(/\{([^{}]+)\}/g, (_match, options: string) => {
    const choices = options.split("|");
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

export function resolveTemplate(text: string, contact: MergeContact): string {
  return resolveSpintext(resolveMergeFields(text, contact));
}

/** After full resolution, any leftover brace means either an unknown merge
 * field or malformed spintext — surfaced so a send is never accidentally
 * fired with `{{Unknown Field}}` or a stray `{a|b` in it. */
export function findUnresolvedTokens(text: string): string[] {
  const matches = text.match(/\{[^{}]*\}?|\}/g);
  return matches ?? [];
}
