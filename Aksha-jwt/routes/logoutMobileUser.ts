import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import * as jose from 'jose';
import { dbClient } from '../models/dbClient';
import { JWT_SECRET } from '../middleware/validateJWT';

const TABLE_NAME = 'Aksha_Mobile_Users';

const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const logoutMobileUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {

        // ── Get JWT from Authorization header ──────────────────────────
        const authHeader = event.headers?.Authorization || event.headers?.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ message: 'Missing or invalid Authorization header' }),
            };
        }

        const token = authHeader.split(' ')[1];

        // ── Verify JWT and extract email ────────────────────────────────
        let email: string;
        try {
            const { payload } = await jose.jwtVerify(token, JWT_SECRET);
            email = payload.email as string;

            if (!email) {
                return {
                    statusCode: 401,
                    headers,
                    body: JSON.stringify({ message: 'Invalid token — email not found' }),
                };
            }
        } catch {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ message: 'Invalid or expired token' }),
            };
        }

        // ── Remove expoToken from DynamoDB ──────────────────────────────
        // This stops push notifications immediately after logout
        await dbClient.send(
            new UpdateItemCommand({
                TableName: TABLE_NAME,
                Key: { email: { S: email } },
                UpdateExpression: 'REMOVE expoToken',   // removes the field entirely
            })
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                message: 'Logged out successfully',
                email,
            }),
        };

    } catch (err) {
        console.error('Error in logoutMobileUser:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};

export default logoutMobileUser;