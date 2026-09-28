import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    AttributeValue,
    DynamoDBClient,
    QueryCommand,
} from '@aws-sdk/client-dynamodb';

// ── DYNAMODB CLIENT ───────────────────────────────────────────────────────────
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

// Same table/attribute names the Aksha_Pipeline notification.py writer uses
// (save_group_alert_details): partition key groupId, sort key alertId,
// TTL attribute expiresAt.
const TABLE_NAME = process.env.ALERTS_TABLE_NAME ?? 'Aksha_Mobile_Alerts';

// Hard ceiling on pagination loops. A single group's partition should never
// legitimately need this many pages at 24h TTL retention — this only exists
// so a runaway/misconfigured table can't turn one request into an unbounded
// Lambda execution.
const MAX_PAGES = 25;

// ── Drain every page of a group's partition ──────────────────────────────────
// QueryCommand caps a single response at ~1MB. Without this loop, a group
// with enough alerts in its partition would have results silently
// truncated — this is the server-side half of the batching plan (the app
// never has to know DynamoDB paginates; it always gets one complete list).
const queryAllPages = async (groupId: string): Promise<Record<string, AttributeValue>[]> => {
    const items: Record<string, AttributeValue>[] = [];
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
    let pages = 0;

    do {
        const result = await dbClient.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: 'groupId = :gid',
                ExpressionAttributeValues: {
                    ':gid': { S: groupId },
                },
                ExclusiveStartKey: lastEvaluatedKey,
            })
        );

        items.push(...(result.Items ?? []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        pages += 1;

        if (lastEvaluatedKey) {
            console.log(`[getAlerts] page ${pages} for groupId=${groupId}: ${result.Items?.length ?? 0} item(s), more pages pending`);
        }
    } while (lastEvaluatedKey && pages < MAX_PAGES);

    if (lastEvaluatedKey) {
        console.warn(`[getAlerts] groupId=${groupId} hit MAX_PAGES=${MAX_PAGES} — some items were not read. Investigate partition size / TTL.`);
    }

    return items;
};

// ── LAMBDA HANDLER ────────────────────────────────────────────────────────────
const getAlerts = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // groupId comes from the path, e.g. /mobile/alerts/6a5ddc6c9165c72018867e00
    const match = event.path.match(/\/mobile\/alerts\/([^/]+)/);
    const groupId = match?.[1];

    // Delta sync support: the app sends ?since=<ISO timestamp> to request
    // only alerts newer than its last successful sync. Comparison is against
    // createdAt — the same field the app normalizes into `receivedAt` and
    // uses as its own sync cursor, so both sides agree on what "since" means.
    //
    // 'before' is the mirror-image mode: walks backward in time from a given
    // point, newest-first. Used when the app wants to show the freshest
    // alerts immediately and backfill older backlog afterward, instead of
    // making the user wait through the entire backlog oldest-first.
    // Only one of since/before is expected per call — before takes priority
    // if both are somehow present, since it's the more specific request.
    const since = event.queryStringParameters?.since;
    const before = event.queryStringParameters?.before;
    const backward = !!before;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Forward mode floor: never go older than 24h regardless of client input.
    const effectiveSince = since && since > twentyFourHoursAgo ? since : twentyFourHoursAgo;
    // Backward mode floor: same 24h clamp, but as an upper-bound-less lower
    // bound — items must still be newer than 24h ago even when walking back.
    const effectiveBefore = before ?? new Date().toISOString();

    console.log(`[getAlerts] invoked: path=${event.path} groupId=${groupId} mode=${backward ? 'before' : 'since'} since=${since ?? 'none'} before=${before ?? 'none'} queryParams=${JSON.stringify(event.queryStringParameters)}`);

    if (!groupId) {
        console.log('[getAlerts] rejected: missing groupId in path');
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'groupId is required in path' }),
        };
    }

    const limitParam = Number(event.queryStringParameters?.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;

    try {
        console.log(`[getAlerts] querying table=${TABLE_NAME} groupId=${groupId} limit=${limit}`);
        const rawItems = await queryAllPages(groupId);
        console.log(`[getAlerts] drained ${rawItems.length} raw item(s) total for groupId=${groupId}`);

        const now = Math.floor(Date.now() / 1000);

        let parseFailures = 0;
        let filteredBySince = 0;
        const alerts = rawItems
            .map((item) => {
                let data: Record<string, unknown> = {};
                try {
                    data = item.data?.S ? JSON.parse(item.data.S) : {};
                } catch {
                    parseFailures += 1;
                    data = {};
                }

                return {
                    groupId:      item.groupId?.S ?? '',
                    alertId:      item.alertId?.S ?? '',
                    cameraName:   item.cameraName?.S ?? '',
                    incidentTime: item.incidentTime?.S ?? '',
                    title:        item.title?.S ?? '',
                    body:         item.body?.S ?? '',
                    createdAt:    item.createdAt?.S ?? '',
                    expiresAt:    Number(item.expiresAt?.N ?? 0),
                    data,
                };
            })
            .filter((alert) => alert.expiresAt > now)
            .filter((alert) => {
                if (backward) {
                    // Backward mode: strictly older than the cursor, but never
                    // older than the 24h floor.
                    const keep = alert.createdAt < effectiveBefore && alert.createdAt > twentyFourHoursAgo;
                    if (!keep) filteredBySince += 1;
                    return keep;
                }
                const keep = alert.createdAt > effectiveSince;
                if (!keep) filteredBySince += 1;
                return keep;
            })
            // Forward mode sorts ascending (so the last item's createdAt is a
            // valid "resume from here" cursor for the next since= call).
            // Backward mode sorts descending (newest first) — the last item
            // in THIS page is the next page's `before` cursor, walking
            // further into the past each time.
            .sort((a, b) => {
                if (backward) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
                return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
            });

        const page = alerts.slice(0, limit);
        // Lets the app's own batch loop know there's more beyond this page —
        // it can request again with the same `since` and a higher `limit`,
        // or a future cursor param, instead of assuming one page is everything.
        const hasMore = alerts.length > limit;

        if (parseFailures > 0) {
            console.log(`[getAlerts] warning: ${parseFailures} item(s) had unparseable 'data' JSON for groupId=${groupId}`);
        }
        console.log(`[getAlerts] mode=${backward ? 'before' : 'since'} excluded ${filteredBySince} item(s) outside range for groupId=${groupId}`);
        console.log(`[getAlerts] returning ${page.length} alert(s) (of ${alerts.length} matching, limit=${limit}, hasMore=${hasMore}) for groupId=${groupId}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ groupId, alerts: page, hasMore }),
        };

    } catch (err) {
        console.error(`[getAlerts] error for groupId=${groupId}:`, err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error' }),
        };
    }
};

export default getAlerts;