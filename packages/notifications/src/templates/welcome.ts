import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface WelcomePayload {
  name: string | null;
  dailyLimit: number;
}

export function renderWelcome(ctx: EmailContext<WelcomePayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hey ${escapeHtml(ctx.payload.name)},` : 'Hey,';
  const limit = ctx.payload.dailyLimit;
  const appUrl = escapeHtml(ctx.publicAppUrl);

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;margin:0 0 16px">Welcome to ToolCairn</h1>
<p>${greeting}</p>
<p>You now have agent-native access to ToolCairn's live tool intelligence graph — health, compatibility, and real-world fit for every library in our catalog.</p>
<p style="margin:20px 0 8px"><strong>Your free tier:</strong></p>
<ul style="margin:0 0 20px;padding-left:20px">
  <li>~<strong>${limit}</strong> MCP tool calls per day (UTC-reset)</li>
  <li>Full access to search_tools, get_stack, compare_tools, check_compatibility</li>
  <li>Auto-scanning of your project dependencies</li>
</ul>
<p style="margin:20px 0 8px"><strong>First steps:</strong></p>
<ol style="margin:0 0 24px;padding-left:20px">
  <li>Install the MCP: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-family:'SF Mono',Consolas,monospace;font-size:13px">npm i -g @neurynae/toolcairn-mcp</code></li>
  <li>Authenticate: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-family:'SF Mono',Consolas,monospace;font-size:13px">toolcairn auth</code></li>
  <li>Your agent does the rest — ToolCairn auto-inits per project root.</li>
</ol>
<p style="text-align:center;margin:32px 0">
  <a href="${appUrl}/docs" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Read the quickstart</a>
</p>
<p style="color:#6b7280;font-size:13px">Questions? Just reply to this email — I read every one.</p>
<p style="color:#6b7280;font-size:13px">— The ToolCairn team</p>`;

  const html = renderLayout({
    preheader: `Welcome — you have ${limit} daily tool calls to play with.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: 'Welcome to ToolCairn — your agent intelligence starts here',
    html,
    text: toPlainText(bodyHtml),
    preheader: `Welcome — you have ${limit} daily tool calls to play with.`,
  };
}
