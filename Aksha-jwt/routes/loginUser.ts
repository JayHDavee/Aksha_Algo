import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import * as jose from 'jose';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';
import { JWT_SECRET, validateToken } from '../middleware/validateJWT';

const RequestBodySchema = z.object({
    email:        z.string().email(),
    passwordHash: z.string(),
});

const loginUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Missing body' }),
            };
        }

        const rawBody = JSON.parse(event.body);
        const body    = RequestBodySchema.parse(rawBody);
        const { email, passwordHash } = body;

        // Retrieve user from DynamoDB
        const checkUser = await dbClient.send(
            new GetItemCommand({
                TableName: process.env.TABLE_NAME,
                Key: { email: { S: email } },
            })
        );

        if (!checkUser.Item) {
            return {
                statusCode: 401,
                body: JSON.stringify({ message: 'User does not exist' }),
            };
        }

        const userItem = checkUser.Item;
        const storedHashedPassword = userItem.passwordHash?.S;

        if (!storedHashedPassword) {
            return {
                statusCode: 500,
                body: JSON.stringify({ message: 'Stored password not found' }),
            };
        }

        const isPasswordValid = passwordHash === storedHashedPassword;
        if (!isPasswordValid) {
            return {
                statusCode: 401,
                body: JSON.stringify({ message: 'Incorrect password' }),
            };
        }

        const isVerified = userItem.verified?.BOOL ?? true;
        if (!isVerified) {
            return {
                statusCode: 401,
                body: JSON.stringify({ message: 'User email not verified' }),
            };
        }

        // Generate JWT — include siteId in payload
        const jwtToken = await new jose.SignJWT({
            email:       userItem.email.S,
            role:        userItem.role.S,
            companyName: userItem.companyName?.S || '',
            siteId:      userItem.siteId?.S || '',   // ← ADD
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('algosign')
            .setExpirationTime(process.env.JWT_EXPIRY || '12h')
            .sign(JWT_SECRET);

        await validateToken(jwtToken);

        return {
            statusCode: 200,
            headers: {
                'Content-Type':                'application/json',
                'Set-Cookie':                  `token=${jwtToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=3600;`,
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
                message:     'User logged in successfully',
                email,
                Email:       userItem.Email?.S       || '',
                Client:      userItem.ClientName?.S  || '',
                Username:    userItem.username?.S    || '',
                role:        userItem.role?.S        || '',
                siteId:      userItem.siteId?.S      || '',   // ← ADD
                token:       jwtToken,
            }),
        };

    } catch (err) {
        console.error('Error in loginUser:', err);

        if (err instanceof z.ZodError) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid input', errors: err.errors }),
            };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};

export default loginUser;