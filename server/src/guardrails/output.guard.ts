import { POLICY, type GuardVerdict } from "./policy.js";

/**
 * Layer 4: what we show back to the user.
 *
 * Catches two things the earlier layers cannot:
 *
 *   1. A leaked system prompt. Input guarding cannot prevent this — the model
 *      decides what to emit — so it is checked on the way out.
 *   2. Secrets that arrived through a TOOL, not through the user. An email
 *      body containing an API key would otherwise be echoed straight into the
 *      transcript and stored in the database.
 *
 * Also normalises links, because a model summarising an attacker's email can
 * happily reproduce a `javascript:` or `data:` URL from it, and Markdown
 * renders that as a clickable link.
 */

function redactSecrets(text: string): { value: string; found: string[] } {
  let value = text;
  const found: string[] = [];

  for (const { label, pattern } of POLICY.input.secretPatterns) {
    pattern.lastIndex = 0;

    if (pattern.test(value)) {
      found.push(label);
      pattern.lastIndex = 0;
      value = value.replace(pattern, `[redacted:${label}]`);
    }
  }

  return { value, found };
}

/**
 * Strip Markdown links whose scheme is not allowed.
 *
 * The link text is kept so the sentence still reads; only the destination is
 * removed. Replacing the whole thing would leave answers with holes in them.
 */
function sanitiseLinks(text: string): { value: string; blocked: number } {
  let blocked = 0;

  const value = text.replace(
    /\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (match, label: string, href: string) => {
      try {
        // Relative links have no scheme; new URL needs a base to parse them.
        const url = new URL(href, "https://placeholder.invalid");

        if (
          (POLICY.output.allowedLinkSchemes as readonly string[]).includes(
            url.protocol,
          )
        ) {
          return match;
        }
      } catch {
        // Unparseable is treated the same as disallowed.
      }

      blocked += 1;
      return `${label} [link removed]`;
    },
  );

  return { value, blocked };
}

export function guardOutput(rawAnswer: string): GuardVerdict {
  const flags: string[] = [];

  // 1. System prompt leak. Replace wholesale — a partly redacted system prompt
  //    is still a leaked system prompt, and the answer is untrustworthy anyway.
  const leaked = POLICY.output.leakMarkers.some((marker) =>
    rawAnswer.includes(marker),
  );

  if (leaked) {
    return {
      ok: true,
      value:
        "I started to repeat my own configuration there, which I shouldn't do. Ask me again and I'll answer properly.",
      flags: ["output.prompt_leak"],
    };
  }

  // 2. Credentials that came back through a tool result.
  const { value: noSecrets, found } = redactSecrets(rawAnswer);
  for (const label of found) flags.push(`output.redacted.${label}`);

  // 3. Dangerous link schemes.
  const { value, blocked } = sanitiseLinks(noSecrets);
  if (blocked > 0) flags.push("output.unsafe_link");

  return { ok: true, value, flags };
}
