import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    UpdateItemCommand,
    GetItemCommand,
    QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { z } from 'zod';

// ── DYNAMODB CLIENT ───────────────────────────────────────────────────────────
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

const TABLE_NAME = 'Aksha_Mobile_Users';

// ── REQUEST SCHEMA ────────────────────────────────────────────────────────────
const RequestBodySchema = z.object({
    mobile_ids: z.string().min(1, 'mobile_ids is required'),
    group_id:   z.string().min(1, 'group_id is required'),   // ← added
    group_name: z.string().min(1, 'group_name is required'),
    action:     z.enum(['add', 'remove', 'enable', 'disable']).default('add'), // ← added enable/disable
});

// ── LAMBDA HANDLER ────────────────────────────────────────────────────────────
const updateGroups = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (!event.body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Missing request body' }),
        };
    }

    let rawBody: unknown;
    try {
        rawBody = JSON.parse(event.body);
    } catch {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Invalid JSON in request body' }),
        };
    }

    const parseResult = RequestBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                message: 'Validation failed',
                errors: parseResult.error.flatten().fieldErrors,
            }),
        };
    }

    const { mobile_ids, group_id, group_name, action } = parseResult.data;

    // ── Combined key: "groupId:groupName" ─────────────────────────────────────
    const groupEntry = `${group_id}:${group_name}`;

    const mobileIdList = mobile_ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

    if (mobileIdList.length === 0) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'No valid mobile_ids provided' }),
        };
    }

    const results: { mobile_id: string; status: string; reason?: string }[] = [];

    for (const mobile_id of mobileIdList) {
        try {
            // ── Find email by mobile_id using GSI ─────────────────────────────
            const queryResult = await dbClient.send(
                new QueryCommand({
                    TableName: TABLE_NAME,
                    IndexName: 'mobile_id-index',
                    KeyConditionExpression: 'mobile_id = :mid',
                    ExpressionAttributeValues: {
                        ':mid': { S: mobile_id },
                    },
                    Limit: 1,
                })
            );

            if (!queryResult.Items || queryResult.Items.length === 0) {
                results.push({ mobile_id, status: 'not_found' });
                continue;
            }

            const email = queryResult.Items[0].email?.S;
            if (!email) {
                results.push({ mobile_id, status: 'no_email' });
                continue;
            }

            // ── Handle enable/disable (just toggle notifications_enabled) ─────
            if (action === 'enable' || action === 'disable') {
                await dbClient.send(
                    new UpdateItemCommand({
                        TableName: TABLE_NAME,
                        Key: { email: { S: email } },
                        UpdateExpression: 'SET notifications_enabled = :val',
                        ExpressionAttributeValues: {
                            ':val': { BOOL: action === 'enable' },
                        },
                    })
                );
                results.push({ mobile_id, status: action === 'enable' ? 'enabled' : 'disabled' });
                continue;
            }

            // ── Get existing groups ───────────────────────────────────────────
            const getResult = await dbClient.send(
                new GetItemCommand({
                    TableName: TABLE_NAME,
                    Key: { email: { S: email } },
                })
            );

            const existingGroups: string[] = getResult.Item?.groups?.SS
                ? Array.from(getResult.Item.groups.SS)
                : [];

            let updatedGroups: string[];

            if (action === 'add') {
                if (existingGroups.includes(groupEntry)) {
                    results.push({ mobile_id, status: 'already_exists' });
                    continue;
                }
                updatedGroups = [...existingGroups, groupEntry];
            } else {
                // remove — match by groupId prefix since name could change
                updatedGroups = existingGroups.filter(
                    (g) => !g.startsWith(`${group_id}:`)
                );

                if (updatedGroups.length === existingGroups.length) {
                    results.push({ mobile_id, status: 'not_in_groups' });
                    continue;
                }
            }

            if (updatedGroups.length === 0) {
                // No groups left — remove attribute and disable notifications
                await dbClient.send(
                    new UpdateItemCommand({
                        TableName: TABLE_NAME,
                        Key: { email: { S: email } },
                        UpdateExpression:
                            'REMOVE #groups SET notifications_enabled = :disabled',
                        ExpressionAttributeNames: {
                            '#groups': 'groups',
                        },
                        ExpressionAttributeValues: {
                            ':disabled': { BOOL: false },
                        },
                    })
                );
            } else {
                await dbClient.send(
                    new UpdateItemCommand({
                        TableName: TABLE_NAME,
                        Key: { email: { S: email } },
                        UpdateExpression:
                            'SET #groups = :groups, notifications_enabled = :enabled',
                        ExpressionAttributeNames: {
                            '#groups': 'groups',
                        },
                        ExpressionAttributeValues: {
                            ':groups':  { SS: updatedGroups },
                            ':enabled': { BOOL: action === 'add' },
                        },
                    })
                );
            }

            results.push({ mobile_id, status: action === 'add' ? 'added' : 'removed' });

        } catch (err) {
            console.error(`Error updating mobile_id ${mobile_id}:`, err);
            results.push({ mobile_id, status: 'error', reason: String(err) });
        }
    }

    const allSuccess = results.every(
        (r) => ['added', 'removed', 'enabled', 'disabled', 'already_exists', 'not_in_groups'].includes(r.status)
    );

    return {
        statusCode: allSuccess ? 200 : 207,
        headers,
        body: JSON.stringify({
            message: allSuccess ? 'All users updated successfully' : 'Some updates failed',
            results,
        }),
    };
};

export default updateGroups;