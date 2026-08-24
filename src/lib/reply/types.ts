export type ReplyCategory =
  | "interested"
  | "not_interested"
  | "follow_up"
  | "ooo_temporary"
  | "ooo_departed"
  | "opt_out"
  | "bounce"
  | "unclear";

export type ParsedEmail = {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  receivedAt: string;
  inReplyTo: string | null;
  references: string[];
  labelIds: string[];
};
