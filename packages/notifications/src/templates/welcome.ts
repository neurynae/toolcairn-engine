import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface WelcomePayload {
  name: string | null;
  dailyLimit: number;
}

export function renderWelcome(ctx: EmailContext<WelcomePayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hey ${escapeHtml(ctx.payload.name)},` : 'Hey,';
  const limit = ctx.payload.dailyLimit;
  const _appUrl = escapeHtml(ctx.publicAppUrl);
  const docsUrl = `${ctx.publicAppUrl}/docs`;

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Welcome to ToolCairn</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 20px">You now have agent-native access to ToolCairn&rsquo;s live tool intelligence graph &mdash; health, compatibility, and real-world fit for every library in our catalog.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 20px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Your free tier</p>
      <p style="margin:0 0 6px;font-size:14px">&bull; <strong>~${limit}</strong> MCP tool calls per day (UTC-reset)</p>
      <p style="margin:0 0 6px;font-size:14px">&bull; Full access to <code style="background:#eef2ff;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">search_tools</code>, <code style="background:#eef2ff;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">get_stack</code>, <code style="background:#eef2ff;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">compare_tools</code></p>
      <p style="margin:0;font-size:14px">&bull; Auto-scanning of your project dependencies</p>
    </td>
  </tr>
</table>

<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">First steps</p>
<ol style="margin:0 0 24px;padding-left:22px;font-size:14px;line-height:1.7">
  <li>Install: <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">npm i -g @neurynae/toolcairn-mcp</code></li>
  <li>Authenticate: <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">toolcairn auth</code></li>
  <li>Your agent does the rest &mdash; ToolCairn auto-inits per project root.</li>
</ol>
${renderCtaButton(docsUrl, 'Read the quickstart')}
<p style="margin:28px 0 0;font-size:13px;color:#6b7280">Questions? Just reply to this email &mdash; I read every one.</p>
<p style="margin:8px 0 0;font-size:13px;color:#6b7280">&mdash; The ToolCairn team</p>`;

  const preheader = `Welcome — you have ~${limit} daily tool calls to play with.`;
  return {
    subject: 'Welcome to ToolCairn — your agent intelligence starts here',
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
