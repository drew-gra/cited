/**
 * Hosting-platform detection from robots.txt content. Surfaces whether the
 * file is a platform default (publisher hasn't customized) vs. publisher-
 * controlled, and which platform's default it is.
 *
 * Why this matters: a newsletter on Beehiiv or Substack with an "open" robots
 * verdict isn't necessarily expressing publisher intent — they may be
 * inheriting whatever the platform decided. Surfacing this distinction is
 * load-bearing for the "show your work" thesis.
 *
 * Signatures here are verified by curling the live robots.txt of known
 * publications on each platform. Add new signatures only after verification.
 */

import { z } from "zod";

export const platformIdSchema = z.enum([
  "beehiiv",
  "substack",
  "ghost",
  "wordpress",
  "wix",
  "unknown",
]);

export const platformDetectionSchema = z.object({
  platform: platformIdSchema,
  isDefault: z.boolean(),
  note: z.string(),
});

export type PlatformId = z.infer<typeof platformIdSchema>;
export type PlatformDetection = z.infer<typeof platformDetectionSchema>;

// Beehiiv ships a self-labeled default. The first comment line is literal.
const BEEHIIV_DEFAULT_MARKER = /^\s*#\s*beehiiv default robots\.txt/im;

// Substack publications (custom-domain or *.substack.com) serve a Substack-
// managed robots.txt. Two shapes exist: substack.com itself (short, BLEXBot
// + Twitterbot only), and publication pages (longer, with Substack-specific
// admin paths). Since 2024, Substack lets publishers opt into per-bot rules
// for AI crawlers — so the file is no longer guaranteed to be "the default."
const SUBSTACK_BLEXBOT = /User-agent:\s*BLEXBot\b/i;
const SUBSTACK_TWITTERBOT = /User-agent:\s*Twitterbot\b/i;
const SUBSTACK_INTERNAL_PATH =
  /Disallow:\s*\/(?:visited-surface-frame|lovestack|channel-frame|session-attribution-frame)/i;
const SUBSTACK_SHORT_FILE_MAX = 200;

// Ghost-hosted publications expose admin paths under /ghost/ or /.ghost/.
// The publisher CAN customize the rest of the file.
const GHOST_PATH = /^\s*Disallow:\s*\/\.?ghost\//im;

// WordPress detection. /wp-admin/ alone is too weak — non-WP sites
// (washingtonpost.com on Arc XP, for example) keep defensive /wp-admin/
// blocks in their robots.txt. Require either a second WP-specific marker
// (/wp-json/, /wp-login, /wp-content/), the Yoast SEO block markers, or the
// exact virtual-default file.
const WORDPRESS_ADMIN_PATH = /Disallow:\s*\/wp-admin\b/i;
const WORDPRESS_SECONDARY_MARKER = /\/(?:wp-json|wp-login|wp-content)/i;
const YOAST_BLOCK = /#\s*START YOAST BLOCK/i;
// The "virtual" default WordPress generates when no physical robots.txt
// exists is exactly:
//   User-agent: *
//   Disallow: /wp-admin/
//   Allow: /wp-admin/admin-ajax.php
const WORDPRESS_VIRTUAL_DEFAULT_MAX = 150;
const WORDPRESS_ADMIN_AJAX_ALLOW =
  /Allow:\s*\/wp-admin\/admin-ajax\.php/i;

// Wix sites expose an internal product path that no other platform uses.
const WIX_PATH = /\/pro-gallery-webapp\//i;

// Any explicit User-agent block for a v1 AI bot. Used to detect when a
// platform-default file has been overridden with publisher AI-bot opt-in.
const AI_BOT_USER_AGENT =
  /^[ \t]*User-agent:[ \t]*(?:GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Google-Extended|PerplexityBot|Perplexity-User|CCBot)\b/im;

export function detectPlatform(rawText: string | null): PlatformDetection {
  if (!rawText) {
    return { platform: "unknown", isDefault: false, note: "" };
  }

  if (BEEHIIV_DEFAULT_MARKER.test(rawText)) {
    return {
      platform: "beehiiv",
      isDefault: true,
      note: "Beehiiv platform default robots.txt — the publisher has not customized this file. AI access policy here is set by the platform, not the publisher.",
    };
  }

  if (SUBSTACK_BLEXBOT.test(rawText)) {
    const isPublication = SUBSTACK_INTERNAL_PATH.test(rawText);
    const isMarketing =
      rawText.trim().length <= SUBSTACK_SHORT_FILE_MAX &&
      SUBSTACK_TWITTERBOT.test(rawText);
    if (isPublication || isMarketing) {
      const publisherCustomized = AI_BOT_USER_AGENT.test(rawText);
      return {
        platform: "substack",
        isDefault: !publisherCustomized,
        note: publisherCustomized
          ? "Substack publication with publisher-customized AI bot rules. Substack added a per-publication AI-bot opt-in toggle in 2024; this publisher has used it. AI access reflects publisher intent on top of Substack's boilerplate."
          : "Substack platform default — publisher has not opted into AI bot rules. AI access here is set by Substack's boilerplate.",
      };
    }
  }

  if (GHOST_PATH.test(rawText)) {
    return {
      platform: "ghost",
      isDefault: false,
      note: "Ghost-hosted publication — Ghost auto-adds /ghost/ admin paths to robots.txt, but publishers can customize the rest. Verdict reflects the publisher's edits on top of Ghost defaults.",
    };
  }

  const isVirtualDefault =
    rawText.trim().length <= WORDPRESS_VIRTUAL_DEFAULT_MAX &&
    WORDPRESS_ADMIN_AJAX_ALLOW.test(rawText);
  const hasYoast = YOAST_BLOCK.test(rawText);
  const hasStrongWpSignal =
    WORDPRESS_ADMIN_PATH.test(rawText) &&
    WORDPRESS_SECONDARY_MARKER.test(rawText);
  if (isVirtualDefault || hasYoast || hasStrongWpSignal) {
    const yoastManaged = hasYoast;
    return {
      platform: "wordpress",
      isDefault: isVirtualDefault,
      note: isVirtualDefault
        ? "WordPress virtual default robots.txt — no physical file present, WordPress is generating the minimal default. Publisher has not customized."
        : yoastManaged
          ? "WordPress with Yoast SEO managing robots.txt — file is generated by the Yoast plugin's settings, not hand-written. Publisher controls Yoast's settings but may not realize what's emitted."
          : "WordPress-hosted (or self-hosted WordPress) — robots.txt is customized beyond the WordPress default.",
    };
  }

  if (WIX_PATH.test(rawText)) {
    return {
      platform: "wix",
      isDefault: false,
      note: "Wix-hosted site — Wix auto-adds /pro-gallery-webapp/ and similar internal paths. Publishers can edit the rest of robots.txt through the Wix dashboard.",
    };
  }

  return { platform: "unknown", isDefault: false, note: "" };
}
