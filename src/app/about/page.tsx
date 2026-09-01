export default function AboutPage() {
  return (
    <div className="mx-auto max-w-[640px] px-8 py-16">
      <h1 className="font-display text-3xl italic">Mailflow</h1>
      <p className="mt-6 text-pretty leading-relaxed">
        Mailflow is a private outreach and contact-management tool built for Jayme Stone Agency, a
        music booking agency. It is used internally to manage relationships with venues, festivals,
        and presenters, and to run cold-outreach email campaigns on the agency&apos;s own behalf.
      </p>
      <p className="mt-4 text-pretty leading-relaxed">
        Mailflow connects to the agency&apos;s own Gmail accounts to send campaign emails, thread
        follow-ups as genuine replies, and automatically classify and label incoming responses
        (interested, not interested, out of office, and so on) directly in Gmail. It does not send
        or read email on behalf of anyone outside the agency, and it is not a public product —
        access is restricted to the agency&apos;s own team.
      </p>
      <p className="mt-4 text-pretty leading-relaxed">
        Questions about this app or its use of Gmail access can be sent to{" "}
        <a href="mailto:jayme@jaymestone.com" className="underline">
          jayme@jaymestone.com
        </a>
        .
      </p>
    </div>
  );
}
