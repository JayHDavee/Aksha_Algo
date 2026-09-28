// EventBridge-triggered Lambda entrypoint — NOT routed through app.ts's API
// Gateway router. Deploy this as a second Lambda function from the same
// container image, with the handler overridden to
// `dist/healthCheckHandler.handler`, and target it from an EventBridge
// scheduled rule (rate: 15 minutes).
//
// Scans Aksha_System_Health (one item per deployed site, keyed by siteId) and,
// for every site whose heartbeat has gone stale, sends an alert email to that
// site's configured emergency contacts.

import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { sendSystemDownAlertEmail } from './email/healthAlertEmail';
import { HEALTH_TABLE_NAME } from './routes/getHealthSettings';

const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

const STALE_THRESHOLD_SECONDS = 15 * 60; // 15 minutes — matches the EventBridge tick
const ALERT_RESEND_INTERVAL_SECONDS = Number(process.env.ALERT_RESEND_INTERVAL_SECONDS ?? 3600); // 1 hour

interface HealthItem {
    siteId: string;
    systemUpTimestamp?: number;
    alertActiveRange?: string;
    emergencyEmails?: string;
    lastAlertSentAt?: number;
    // Diagnostic snapshot — written every check cycle by the local health
    // agent (health_agent/health_agent.py), healthy or not, so the alert
    // email can explain *why* the system is down, not just that it's stale.
    lastCheckAt?: number;
    coreContainersOk?: boolean;
    missingCoreContainers?: string;
    pipelineRunning?: boolean;
    internetReachable?: boolean;
    failedChecks?: string;
}

// "HH:MM-HH:MM" in Asia/Kolkata local time. No range configured → always eligible.
const isWithinActiveRange = (range: string | undefined, nowIST: Date): boolean => {
    if (!range) return true;

    const match = range.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        console.warn(`Ignoring malformed alert_active_range "${range}" — treating as always-active`);
        return true;
    }

    const [, startH, startM, endH, endM] = match;
    const startMinutes = Number(startH) * 60 + Number(startM);
    const endMinutes = Number(endH) * 60 + Number(endM);
    const nowMinutes = nowIST.getHours() * 60 + nowIST.getMinutes();

    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    }
    // Overnight range (e.g. 21:00-06:00)
    return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
};

const getNowInIST = (): Date =>
    new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

export const handler = async (): Promise<void> => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const nowIST = getNowInIST();

    let items: Record<string, any>[] = [];
    try {
        const scanResult = await dbClient.send(new ScanCommand({ TableName: HEALTH_TABLE_NAME }));
        items = scanResult.Items ?? [];
    } catch (error) {
        console.error('Failed to scan health table:', error);
        return;
    }

    console.log(`Checking ${items.length} site(s) in ${HEALTH_TABLE_NAME}`);

    for (const rawItem of items) {
        const item: HealthItem = {
            siteId: rawItem.siteId?.S ?? '',
            systemUpTimestamp: rawItem.system_up_timestamp?.N ? Number(rawItem.system_up_timestamp.N) : undefined,
            alertActiveRange: rawItem.alert_active_range?.S,
            emergencyEmails: rawItem.emergency_emails?.S,
            lastAlertSentAt: rawItem.last_alert_sent_at?.N ? Number(rawItem.last_alert_sent_at.N) : undefined,
            lastCheckAt: rawItem.last_check_at?.N ? Number(rawItem.last_check_at.N) : undefined,
            coreContainersOk: rawItem.core_containers_ok?.BOOL,
            missingCoreContainers: rawItem.missing_core_containers?.S,
            pipelineRunning: rawItem.pipeline_running?.BOOL,
            internetReachable: rawItem.internet_reachable?.BOOL,
            failedChecks: rawItem.failed_checks?.S,
        };

        if (!item.siteId) continue;

        try {
            if (item.systemUpTimestamp === undefined) {
                console.log(`[${item.siteId}] no heartbeat recorded yet — skipping`);
                continue;
            }

            const ageSeconds = nowEpoch - item.systemUpTimestamp;
            if (ageSeconds <= STALE_THRESHOLD_SECONDS) {
                console.log(`[${item.siteId}] healthy (last heartbeat ${ageSeconds}s ago)`);
                continue;
            }

            console.warn(`[${item.siteId}] STALE — last heartbeat ${ageSeconds}s ago`);

            if (!isWithinActiveRange(item.alertActiveRange, nowIST)) {
                console.log(`[${item.siteId}] outside alert_active_range (${item.alertActiveRange}) — not alerting`);
                continue;
            }

            if (item.lastAlertSentAt !== undefined && nowEpoch - item.lastAlertSentAt < ALERT_RESEND_INTERVAL_SECONDS) {
                console.log(`[${item.siteId}] alert already sent recently — skipping to avoid spamming`);
                continue;
            }

            const recipients = (item.emergencyEmails ?? '')
                .split(',')
                .map((email) => email.trim())
                .filter(Boolean);

            if (recipients.length === 0) {
                console.warn(`[${item.siteId}] stale but no emergency_emails configured — nothing to send`);
                continue;
            }

            await sendSystemDownAlertEmail(item.siteId, recipients, item.systemUpTimestamp, {
                lastCheckAt: item.lastCheckAt,
                coreContainersOk: item.coreContainersOk,
                missingCoreContainers: item.missingCoreContainers,
                pipelineRunning: item.pipelineRunning,
                internetReachable: item.internetReachable,
                failedChecks: item.failedChecks,
            });

            await dbClient.send(
                new UpdateItemCommand({
                    TableName: HEALTH_TABLE_NAME,
                    Key: { siteId: { S: item.siteId } },
                    UpdateExpression: 'SET last_alert_sent_at = :now',
                    ExpressionAttributeValues: { ':now': { N: String(nowEpoch) } },
                })
            );

            console.log(`[${item.siteId}] alert email sent to: ${recipients.join(', ')}`);
        } catch (error) {
            console.error(`[${item.siteId}] error while processing health check:`, error);
        }
    }
};
