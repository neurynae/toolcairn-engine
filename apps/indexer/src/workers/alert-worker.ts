/**
 * Alert Worker — delivers deprecation alerts to subscribers via webhook.
 *
 * Called after a DeprecationAlert is created for a tool.
 * Looks up all AlertSubscription records for that tool, fetches each user's
 * webhook URL, and POSTs a JSON payload.
 *
 * Fire-and-forget: failures are logged but never crash the indexer pipeline.
 */

import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:alert-worker' });

export interface AlertPayload {
  event: 'tool.deprecation';
  tool_name: string;
  reason: string;
  severity: 'warning' | 'critical';
  details: string;
  detected_at: string;
  toolcairn_url: string;
}

/**
 * Deliver deprecation alerts for a tool to all subscribed users.
 * Returns the number of webhooks successfully delivered.
 */
export async function deliverDeprecationAlerts(
  toolName: string,
  alertId: string,
  reason: string,
  severity: string,
  details: string,
): Promise<number> {
  let delivered = 0;

  try {
    // Find all subscribers for this tool
    const subscriptions = await prisma.alertSubscription.findMany({
      where: { tool_name: toolName },
      include: { user: { select: { id: true, alertWebhookUrl: true } } },
    });

    if (subscriptions.length === 0) {
      logger.debug({ toolName }, 'No alert subscribers for tool');
      return 0;
    }

    const payload: AlertPayload = {
      event: 'tool.deprecation',
      tool_name: toolName,
      reason,
      severity: severity as AlertPayload['severity'],
      details,
      detected_at: new Date().toISOString(),
      toolcairn_url: `https://toolcairn.neurynae.com/tool/${encodeURIComponent(toolName)}`,
    };

    // Deliver to each subscriber's webhook URL
    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const webhookUrl = sub.user?.alertWebhookUrl;
        if (!webhookUrl) return; // no webhook configured

        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-ToolCairn-Event': 'tool.deprecation',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            delivered++;
            logger.info({ toolName, userId: sub.user_id, status: res.status }, 'Alert delivered');
          } else {
            logger.warn(
              { toolName, userId: sub.user_id, status: res.status },
              'Alert delivery failed',
            );
          }
        } catch (e) {
          logger.warn({ toolName, userId: sub.user_id, err: e }, 'Alert webhook error');
        }
      }),
    );

    // Mark the alert as delivered
    if (delivered > 0) {
      await prisma.deprecationAlert.update({
        where: { id: alertId },
        data: { delivered: true, delivered_at: new Date() },
      });
    }
  } catch (e) {
    logger.error({ toolName, alertId, err: e }, 'Alert worker failed');
  }

  return delivered;
}
