import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetItemCommand, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';

const RequestBodySchema = z.object({
    email:        z.string().email(),
    passwordHash: z.string(),
    role:         z.enum(['user', 'admin']).default('user'),
    companyName:  z.string(),
    username:     z.string(),
});

const CLIENT_NAME = 'developers';
const ALERT_EMAIL = 'cctv.alerts@algoanalytics.com';

/**
 * Generates a site ID from companyName + UUID
 * Example: "Algo Analytics" → "ALGO_ANALYTICS_a1b2c3d4"
 */
const generateSiteId = (companyName: string): string => {
    const slug = companyName
        .toUpperCase()
        .trim()
        .replace(/[^A-Z0-9]+/g, '_')   // replace spaces/special chars with _
        .replace(/^_+|_+$/g, '');       // trim leading/trailing underscores

    const shortUUID = randomUUID().replace(/-/g, '').slice(0, 8); // 8 char UUID

    return `${slug}_${shortUUID}`;      // e.g. ALGO_ANALYTICS_a1b2c3d4
};

const registerUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

    if (!event.body) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing body' }),
        };
    }

    const rawbody = JSON.parse(event.body);

    if (!rawbody) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing required fields' }),
        };
    }

    const body = RequestBodySchema.parse(rawbody);

    if (!body) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing required fields and cannot parse body' }),
        };
    }

    const { email, passwordHash, role, companyName, username } = body;

    const scopes = ['default'];

    // Check if user already exists
    const checkUser = await dbClient.send(
        new GetItemCommand({
            TableName: process.env.TABLE_NAME,
            Key: { email: { S: email } },
        }),
    );

    if (checkUser.Item) {
        return {
            statusCode: 409,
            body: JSON.stringify({ message: 'User already exists' }),
        };
    }

    // Check admin limit per company
    if (role === 'admin') {
        const adminScan = await dbClient.send(
            new ScanCommand({
                TableName: process.env.TABLE_NAME,
                FilterExpression: '#r = :adminRole AND #c = :companyName',
                ExpressionAttributeNames: {
                    '#r': 'role',
                    '#c': 'companyName',
                },
                ExpressionAttributeValues: {
                    ':adminRole':   { S: 'admin' },
                    ':companyName': { S: companyName },
                },
                ProjectionExpression: 'email',
            })
        );

        const adminCount = adminScan.Count || 0;
        if (adminCount >= 3) {
            return {
                statusCode: 403,
                body: JSON.stringify({ message: 'Maximum number of admins reached for this company' }),
            };
        }
    }

    // Generate siteId from companyName + UUID
    const siteId = generateSiteId(companyName);

    // Create the user in DB — siteId added
    await dbClient.send(
        new PutItemCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
                email:        { S: email },
                passwordHash: { S: passwordHash },
                scopes:       { SS: scopes },
                role:         { S: role },
                companyName:  { S: companyName },
                username:     { S: username },
                ClientName:   { S: CLIENT_NAME },
                Email:        { S: ALERT_EMAIL },
                siteId:       { S: siteId },       // ← NEW
            },
        }),
    );

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            siteId,   // ← return so admin can share it with mobile users
        }),
    };
};

export default registerUser;