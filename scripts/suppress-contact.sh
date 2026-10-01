#!/bin/bash
# Suppress + delete a single contact by email address.
#
# Usage: scripts/suppress-contact.sh <email> [reason] [notes]
#   reason defaults to "manual" (bounce | opt_out | manual | departed)
#
# Refuses to act on anything but exactly one match. A near-miss (dictated
# address, hyphen in the wrong place) prints candidates and exits instead
# of guessing -- see the spot-festival.dk / spotfestival.dk case.
#
# Deleted rows are appended to ~/.mailflow-deleted-contacts.jsonl first.
set -euo pipefail

EMAIL="${1:-}"
REASON="${2:-manual}"
NOTES="${3:-Removed at request $(date +%F)}"
BACKUP="$HOME/.mailflow-deleted-contacts.jsonl"

[ -n "$EMAIL" ] || { echo "usage: suppress-contact.sh <email> [reason] [notes]" >&2; exit 2; }
case "$REASON" in bounce|opt_out|manual|departed) ;; *) echo "invalid reason: $REASON" >&2; exit 2;; esac

set -a; source "$HOME/mailflow/.env.local"; set +a

api() { # api METHOD path [body]
  local m="$1" p="$2" b="${3:-}" args
  args=(-s -X "$m" "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/$p"
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
    -H "Content-Type: application/json"
    -H "Prefer: return=representation")
  [ -n "$b" ] && args+=(-d "$b")
  curl "${args[@]}"
}

jq_py() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe='@.'))" "$EMAIL")
MATCH=$(api GET "contacts?email=eq.$ENC&select=*")
COUNT=$(printf '%s' "$MATCH" | jq_py "print(len(d))")

if [ "$COUNT" = "0" ]; then
  echo "No exact match for $EMAIL. Near matches:"
  LOCAL="${EMAIL%%@*}"; DOM="${EMAIL#*@}"; BARE=$(printf '%s' "${DOM%%.*}" | tr -d '-')
  api GET "contacts?or=(email.ilike.*$LOCAL*,email.ilike.*$BARE*,venue.ilike.*$BARE*)&select=id,first_name,last_name,email,venue" \
    | jq_py "[print(f\"  {c['email']:<38} {(c['first_name'] or '')} {(c['last_name'] or '')} — {c['venue']}\") for c in d] or print('  (none)')"
  exit 1
fi
if [ "$COUNT" != "1" ]; then echo "$COUNT exact matches for $EMAIL — refusing to act." >&2; exit 1; fi

ID=$(printf '%s' "$MATCH" | jq_py "print(d[0]['id'])")
printf '%s' "$MATCH" | jq_py "c=d[0];print(f\"Contact: {c['first_name']} {c['last_name'] or ''} <{c['email']}> — {c['venue']} ({c['city']}, {c['state'] or c['country']})\")"
api GET "campaign_members?contact_id=eq.$ID&select=campaign_id,current_step,member_status,last_sent_at" \
  | jq_py "[print(f\"  campaign {m['campaign_id'][:8]} step {m['current_step']} {m['member_status']} last sent {m['last_sent_at']}\") for m in d] or print('  no campaign memberships')"

printf '%s\n' "$MATCH" >> "$BACKUP"

# Built in a quoted heredoc rather than inline: a JSON object literal inside
# nested shell quoting gets eaten as brace expansion, which silently produced
# an empty payload the first time this ran.
PAYLOAD=$(EMAIL="$EMAIL" REASON="$REASON" NOTES="$NOTES" python3 - <<'PY'
import json, os
print(json.dumps([{"email": os.environ["EMAIL"], "reason": os.environ["REASON"], "notes": os.environ["NOTES"]}]))
PY
)

# Suppress FIRST and confirm it actually landed before deleting anything.
# Deleting a contact whose suppression quietly failed is the one outcome
# worse than doing nothing: the address is no longer in the contact list to
# be noticed, and nothing stops a future import from mailing it again.
api POST "suppression" "$PAYLOAD" >/dev/null
SUP=$(api GET "suppression?email=eq.$ENC&select=reason" | jq_py "print(d[0]['reason'] if d else 'MISSING')")
if [ "$SUP" = "MISSING" ]; then
  echo "Suppression insert failed for $EMAIL — contact NOT deleted." >&2
  exit 1
fi

api DELETE "contacts?id=eq.$ID" >/dev/null

LEFT=$(api GET "contacts?id=eq.$ID&select=id" | jq_py "print(len(d))")
if [ "$LEFT" = "0" ]; then
  echo "Done: contact deleted, suppressed (reason=$SUP). Backup in $BACKUP"
else
  echo "PROBLEM: suppressed, but $LEFT contact row(s) still present." >&2; exit 1
fi
