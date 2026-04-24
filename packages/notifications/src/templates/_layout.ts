// Shared email layout — header + content slot + footer (unsubscribe + CAN-SPAM address).
// Every template wraps its body in renderLayout() so the unsubscribe and physical
// address show on every mail, satisfying Gmail/Yahoo bulk-sender requirements.
import { config } from '@toolcairn/config';
import { escapeHtml, safeUrl } from './_sanitize.js';

const BRAND_COLOR = '#6366f1'; // indigo-500 — matches the web app

export interface LayoutInput {
  preheader?: string;
  /** Pre-rendered HTML body. Must already be escaped. */
  bodyHtml: string;
  /** Per-user unsubscribe URL (magic-link). Falls back to the generic settings page. */
  unsubscribeUrl?: string;
  /** When true, hides the unsubscribe block (used only for legally-required account emails). */
  hideUnsubscribe?: boolean;
}

export function renderLayout(input: LayoutInput): string {
  const unsubHref = safeUrl(input.unsubscribeUrl ?? `${config.PUBLIC_APP_URL}/settings`);
  const address = escapeHtml(config.COMPANY_ADDRESS);
  const preheader = input.preheader
    ? `<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${escapeHtml(input.preheader)}</span>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToolCairn</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f7f9">
  <tr>
    <td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,0.04);max-width:560px">
        <tr>
          <td style="padding:28px 32px 8px">
            <div style="font-size:15px;font-weight:700;color:${BRAND_COLOR};letter-spacing:-0.01em">ToolCairn</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 32px;font-size:15px;line-height:1.55">
${input.bodyHtml}
          </td>
        </tr>
      </table>
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;margin-top:16px">
        <tr>
          <td style="padding:16px 24px;font-size:12px;color:#6b7280;line-height:1.5;text-align:center">
${
  input.hideUnsubscribe
    ? ''
    : `<a href="${unsubHref}" style="color:#6b7280;text-decoration:underline">Unsubscribe or update preferences</a><br>`
}
            You're receiving this because you have a ToolCairn account.<br>
            ${address}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
