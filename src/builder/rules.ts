/**
 * Pure rules for "Design again", text briefs and the builder's notices (3-Nov).
 * No entities or database here, so the rules test without a database.
 */

/** The first web address in a pasted brief: a full URL, or a bare domain such as qaffeine.com. Emails do not count. */
export function webAddressIn(text: string): string | null {
  const url = text.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
  if (url) return url.replace(/[.,;:!?]+$/, "");
  const bare = text.match(/(?<![@\w.-])(?:www\.)?[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.(?:com|in|co|co\.in|store|shop|io|net|org|ai|app|me|uk|co\.uk|ae|us|xyz|online|club|life|world|studio)(?:\/[^\s<>"')]*)?(?![\w@-])/i)?.[0];
  return bare ? `https://${bare.replace(/[.,;:!?]+$/, "")}` : null;
}

/** Design runs one brief may use: the first plus two "Design again" (about $0.30 each). */
export const DESIGN_RUNS_PER_SESSION = 3;
/** Successful design runs so far. Sessions designed before 3-Nov count as one if they have options. */
export function designRuns(tweaks: Record<string, unknown> | null | undefined, hasOptions = false): number {
  const n = Number(tweaks?.design_runs);
  return Number.isFinite(n) && n > 0 ? n : hasOptions ? 1 : 0;
}

/** What Samaira read: the site, the pasted brief, or both. */
export const whatWasRead = (siteDomain: string | null, fromText: boolean): string =>
  siteDomain && fromText ? `${siteDomain} and your brief` : siteDomain ?? (fromText ? "your brief" : "your site");

/**
 * Day 1, 3, 7 after a brief stopped moving. The words follow where it stopped
 * (audit 3-Nov: a session with only options was told "your brief is built"):
 * read but never designed, designed but none chosen, or chosen and not posted.
 * In-app + email; WhatsApp only on day 1 (once).
 */
export function waitingLine(args: { state: string; optionName: string | null; siteDomain: string | null; day: 1 | 3 | 7 }): { title: string; heading: string; em: string; line: string; detail: string; button: string } {
  const tail = args.day === 7 ? " This is the last reminder." : "";
  if (args.state === "researched") {
    const what = args.siteDomain ?? "your brief";
    return {
      title: "Your campaigns are one tap away", heading: "Your campaigns are", em: "one tap away.",
      line: args.day === 1
        ? `Samaira read ${what}. Tap Design and she builds three full campaigns in about two minutes.`
        : args.day === 3 ? `Samaira read ${what} three days ago. Your campaigns are still one tap away.` : `Samaira read ${what} a week ago. Tap Design when you are ready, or delete it under Your briefs.${tail}`,
      detail: "Check her three picks, change any you like, and tap Design.",
      button: "Design my campaigns",
    };
  }
  if (args.state === "options") {
    return {
      title: "Three campaigns are waiting", heading: "Three campaigns are", em: "waiting.",
      line: args.day === 1
        ? "Three campaigns are designed and waiting. Choose one, or design again with your own numbers."
        : args.day === 3 ? "Your three campaigns have waited three days. Choose one, or design again with your own numbers." : `Your three campaigns have waited a week. Choose one, or delete them under Your briefs.${tail}`,
      detail: "Every field is filled in. Choosing one changes nothing until you send it for approval.",
      button: "See my campaigns",
    };
  }
  const name = args.optionName ?? "your brief";
  return {
    title: "A brief is waiting on you", heading: "A brief is", em: "waiting on you.",
    line: args.day === 1
      ? `${name} is built and waiting. Read it once and send it for approval.`
      : args.day === 3 ? `${name} has waited three days. Creators cannot see it until you send it.` : `${name} has waited a week. Send it, or delete it under Your briefs, and we stop reminding you.`,
    detail: "Everything is filled in: platform, deal, deliverables, creators, dates, the brief, the do's and don'ts. Change anything before it goes.",
    button: "Open the brief",
  };
}

