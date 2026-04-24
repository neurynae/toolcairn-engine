// Daily deliverability monitor — computes bounce + complaint rates over the
// last 7 days and emails an admin alert if thresholds are breached.
//
// Gmail's spam-folder classifier keys on these two numbers. Going over
//   bounce    >2%   → start paying attention (warn)
//   bounce    >5%   → sender reputation at risk (critical)
//   complaint >0.1% → start paying attention (warn)
//   complaint >0.3% → Google/Yahoo may delist the sender (critical)
//
// Alert is sent via the normal EmailEvent pipeline so it shows up in admin
// history and is itself subject to the same suppression guarantees.
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';

const logger = createLogger({ name: '@toolcairn/api:deliverability-monitor' });

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const RUN_HOUR_UTC = 4; // 4am UTC = low traffic + after retention cron
const MIN_INTERVAL_MS = 12 * 3600 * 1000;
// Minimum send volume before we start alerting — noise floor filter. With
// only a handful of sends/day a single bounce would otherwise trip 2%.
const MIN_SAMPLE_SIZE = 50;

const BOUNCE_WARN = 0.02;
const BOUNCE_CRITICAL = 0.05;
const COMPLAINT_WARN = 0.001;
const COMPLAINT_CRITICAL = 0.003;

type Severity = 'warn' | 'critical' | 'ok';

interface Snapshot {
  windowStart: Date;
  total: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  bounceRate: number;
  complaintRate: number;
  bounceSeverity: Severity;
  complaintSeverity: Severity;
}

let lastRunAt: number | null = null;
let lastAlertSig: string | null = null;
let timer: NodeJS.Timeout | undefined;

function severity(rate: number, warn: number, critical: number): Severity {
  if (rate >= critical) return 'critical';
  if (rate >= warn) return 'warn';
  return 'ok';
}

async function snapshot(): Promise<Snapshot> {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  const rows = await prisma.emailEvent.groupBy({
    by: ['status'],
    where: { createdAt: { gte: windowStart } },
    _count: { status: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row._count.status;
  const sent = counts.sent ?? 0;
  const delivered = counts.delivered ?? 0;
  const bounced = counts.bounced ?? 0;
  const complained = counts.complained ?? 0;
  const failed = counts.failed ?? 0;
  const total = sent + delivered + bounced + complained;
  const bounceRate = total > 0 ? bounced / total : 0;
  const complaintRate = total > 0 ? complained / total : 0;
  return {
    windowStart,
    total,
    sent,
    delivered,
    bounced,
    complained,
    failed,
    bounceRate,
    complaintRate,
    bounceSeverity: severity(bounceRate, BOUNCE_WARN, BOUNCE_CRITICAL),
    complaintSeverity: severity(complaintRate, COMPLAINT_WARN, COMPLAINT_CRITICAL),
  };
}

async function alertIfBreached(snap: Snapshot): Promise<void> {
  if (snap.total < MIN_SAMPLE_SIZE) {
    logger.debug({ total: snap.total }, 'deliverability: below sample floor, skipping alert');
    return;
  }
  const worst: Severity =
    snap.bounceSeverity === 'critical' || snap.complaintSeverity === 'critical'
      ? 'critical'
      : snap.bounceSeverity === 'warn' || snap.complaintSeverity === 'warn'
        ? 'warn'
        : 'ok';
  if (worst === 'ok') {
    logger.info(
      {
        total: snap.total,
        bounceRate: snap.bounceRate,
        complaintRate: snap.complaintRate,
      },
      'deliverability: healthy',
    );
    return;
  }
  // Alert signature: severity + today's date. Only fires once per severity
  // per UTC day to avoid spamming on every tick.
  const today = new Date().toISOString().slice(0, 10);
  const sig = `${worst}:${today}`;
  if (sig === lastAlertSig) return;
  lastAlertSig = sig;

  const adminEmail = config.EMAIL_REPLY_TO;
  // We look up the admin user to attach a userId (EmailEvent requires one for
  // idempotency). Fall back to the first Pro user as a sensible proxy if
  // EMAIL_REPLY_TO isn't tied to an account.
  const adminUser = await prisma.user.findFirst({
    where: { email: adminEmail },
    select: { id: true },
  });
  if (!adminUser) {
    logger.error(
      { adminEmail, worst, bounceRate: snap.bounceRate, complaintRate: snap.complaintRate },
      'deliverability ALERT (no admin user row — logged only)',
    );
    return;
  }

  await enqueueEmail(prisma, {
    kind: EmailKind.DeliverabilityAlert,
    userId: adminUser.id,
    toEmail: adminEmail,
    scopeKey: `${today}:${worst}`,
    payload: {
      severity: worst,
      windowDays: WINDOW_DAYS,
      total: snap.total,
      sent: snap.sent,
      delivered: snap.delivered,
      bounced: snap.bounced,
      complained: snap.complained,
      failed: snap.failed,
      bounceRate: snap.bounceRate,
      complaintRate: snap.complaintRate,
      bounceSeverity: snap.bounceSeverity,
      complaintSeverity: snap.complaintSeverity,
    },
  });
  logger.warn(
    {
      severity: worst,
      total: snap.total,
      bounceRate: snap.bounceRate,
      complaintRate: snap.complaintRate,
    },
    'deliverability ALERT enqueued',
  );
}

async function runOnce(): Promise<void> {
  try {
    const snap = await snapshot();
    await alertIfBreached(snap);
  } catch (e) {
    logger.error({ err: e }, 'deliverability tick failed');
  }
}

function maybeRun(): void {
  const now = new Date();
  if (now.getUTCHours() !== RUN_HOUR_UTC) return;
  if (lastRunAt && Date.now() - lastRunAt < MIN_INTERVAL_MS) return;
  lastRunAt = Date.now();
  void runOnce();
}

export function startDeliverabilityMonitor(): void {
  if (timer) return;
  logger.info(
    { runHourUtc: RUN_HOUR_UTC, windowDays: WINDOW_DAYS },
    'deliverability-monitor started',
  );
  setTimeout(() => {
    maybeRun();
    timer = setInterval(maybeRun, 10 * 60 * 1000);
  }, 60_000);
}

export function stopDeliverabilityMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
