// Shared email layout. Every template wraps its body here so:
//   - The ToolCairn logo + wordmark sits in a consistent header
//   - Typography hierarchy stays uniform across email kinds
//   - The CAN-SPAM footer (unsubscribe + physical address) is always present
//
// Design rules we're following (don't drift from these without a reason):
//   1. Inline styles only — most clients strip <style> blocks.
//   2. System font stack — avoid webfonts (bandwidth + strict-CSP clients).
//   3. One accent colour (#6366f1 indigo). No gradients, no shadows heavier
//      than 0 1px 2px rgba(0,0,0,0.04). Fancy styling reads as spammy.
//   4. Max width 560px centered on a neutral background.
//   5. Logo max-width 120px, served from the public site (https hosted).
//   6. Table-based layout — div/flex are unreliable in older Outlook.
import { config } from '@toolcairn/config';
import { escapeHtml, safeUrl } from './_sanitize.js';

const BRAND_COLOR = '#6366f1';
const BRAND_COLOR_DARK = '#4f46e5';
const TEXT_PRIMARY = '#111827';
const TEXT_MUTED = '#6b7280';
const TEXT_FAINT = '#9ca3af';
const BORDER = '#e5e7eb';
const SURFACE = '#ffffff';
const BACKGROUND = '#f6f7f9';

const LOGO_URL = `${(config.PUBLIC_APP_URL ?? 'https://toolcairn.neurynae.com').replace(/\/$/, '')}/logo/wordmark.png`;

export interface LayoutInput {
  /** Gmail/inbox preview line. One short sentence. */
  preheader?: string;
  /** Pre-rendered HTML body — must already be escaped. */
  bodyHtml: string;
  /** Per-user unsubscribe URL (magic-link). Fallback: /settings. */
  unsubscribeUrl?: string;
  /** When true, hides the unsubscribe block (legally-required account emails). */
  hideUnsubscribe?: boolean;
}

export function renderLayout(input: LayoutInput): string {
  const unsubHref = safeUrl(input.unsubscribeUrl ?? `${config.PUBLIC_APP_URL}/settings`);
  const address = escapeHtml(config.COMPANY_ADDRESS);
  const preheader = input.preheader
    ? `<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${escapeHtml(input.preheader)}</span>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>ToolCairn</title>
</head>
<body style="margin:0;padding:0;background:${BACKGROUND};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT_PRIMARY};-webkit-font-smoothing:antialiased">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BACKGROUND}">
  <tr>
    <td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:${SURFACE};border:1px solid ${BORDER};border-radius:12px;max-width:560px;overflow:hidden">
        <tr>
          <td align="center" style="padding:28px 32px 20px;border-bottom:1px solid ${BORDER};background:${SURFACE}">
            <img src="${LOGO_URL}" alt="ToolCairn" width="120" height="auto" style="display:block;border:0;outline:none;text-decoration:none;max-width:120px;height:auto">
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 28px;font-size:15px;line-height:1.6;color:${TEXT_PRIMARY}">
${input.bodyHtml}
          </td>
        </tr>
      </table>
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;margin-top:16px">
        <tr>
          <td align="center" style="padding:20px 24px;font-size:12px;color:${TEXT_FAINT};line-height:1.6">
${
  input.hideUnsubscribe
    ? ''
    : `<a href="${unsubHref}" style="color:${TEXT_MUTED};text-decoration:underline">Unsubscribe</a> &nbsp;·&nbsp; <a href="${safeUrl(`${config.PUBLIC_APP_URL}/settings`)}" style="color:${TEXT_MUTED};text-decoration:underline">Manage preferences</a><br><br>`
}
            You&rsquo;re receiving this because you have a ToolCairn account.<br>
            <span style="color:${TEXT_FAINT}">${address}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Shared CTA button snippet — use this in every template body for consistency. */
export function renderCtaButton(href: string, label: string): string {
  const safe = safeUrl(href);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px auto">
  <tr>
    <td align="center" style="border-radius:8px;background:${BRAND_COLOR}">
      <a href="${safe}" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;border:1px solid ${BRAND_COLOR_DARK}">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

export { BRAND_COLOR, TEXT_PRIMARY, TEXT_MUTED, TEXT_FAINT, BORDER };
