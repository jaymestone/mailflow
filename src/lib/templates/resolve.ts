export type MergeContact = {
  first_name?: string | null;
  last_name?: string | null;
  venue?: string | null;
  city?: string | null;
  state?: string | null;
  venue_type?: string | null;
};

const MERGE_FIELDS: Record<string, (c: MergeContact) => string> = {
  "first name": (c) => c.first_name?.trim() || "there",
  "last name": (c) => c.last_name?.trim() || "",
  venue: (c) => c.venue?.trim() || "your venue",
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
