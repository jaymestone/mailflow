export type RampTier = { after_days: number; cap: number };

export type SendAccount = {
  id: string;
  email_address: string;
  ramp_schedule: RampTier[];
  ramp_started_at: string; // date
};

/** The cap in effect today, per the account's ramp schedule (largest
 * after_days tier that's been reached). */
export function effectiveCap(account: SendAccount, today: Date): number {
  const startedAt = new Date(account.ramp_started_at + "T00:00:00Z");
  const daysSinceStart = Math.floor((today.getTime() - startedAt.getTime()) / 86_400_000);

  let cap = account.ramp_schedule[0]?.cap ?? 0;
  for (const tier of account.ramp_schedule) {
    if (daysSinceStart >= tier.after_days) cap = tier.cap;
  }
  return cap;
}

/** Rotates through `accounts` starting just after `cursor`, returning the
 * next account whose count-so-far (in `sentCounts`, mutated as sends are
 * assigned) is under its effective cap for today. Returns null once every
 * account is at capacity. */
export function pickNextAccount(
  accounts: SendAccount[],
  cursor: number,
  sentCounts: Map<string, number>,
  today: Date,
): { account: SendAccount; nextCursor: number } | null {
  if (accounts.length === 0) return null;

  for (let i = 0; i < accounts.length; i++) {
    const index = (cursor + 1 + i) % accounts.length;
    const account = accounts[index];
    const sent = sentCounts.get(account.id) ?? 0;
    if (sent < effectiveCap(account, today)) {
      return { account, nextCursor: index };
    }
  }
  return null;
}
