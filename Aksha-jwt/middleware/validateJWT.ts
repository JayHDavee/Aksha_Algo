import { APIGatewayProxyEvent } from 'aws-lambda';
import * as jose from 'jose';

export const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'secret');

export interface JWTUserinfo {
    // username: string;
    email: string;
}

export class JWTError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JWTError';
    }
}

function extractTokenFromCookies(cookieString: string | undefined): string | null {
    if (!cookieString) return null;
    const cookies = cookieString.split(';').map((cookie) => cookie.trim());
    const tokenCookie = cookies.find((cookie) => cookie.startsWith('token='));
    return tokenCookie ? tokenCookie.split('=')[1] : null;
}

export async function validateToken(token: string) {
    // console.log('Token:', token);
    const secret = JWT_SECRET;
    try {
        const { payload, protectedHeader } = await jose.jwtVerify<JWTUserinfo>(token, secret, {
            issuer: 'algosign',
            maxTokenAge: process.env.JWT_EXPIRY || '12h',
        });

        console.log('Payload:', payload);

        // Validate the payload
        if (!payload.email) {
            throw new Error('Invalid token');
        }

        return payload;
    } catch (error) {
        throw new Error('Invalid token');
    }
}

export const validateJWT = async (event: APIGatewayProxyEvent) => {
    try {
        console.log('Event headers:', event.headers);
        // Extract token from cookies
        const token = extractTokenFromCookies(event.headers.cookie || event.headers.Cookie);

        if (!token) {
            throw new Error('Token not found in cookies');
        }

        console.log('Token:', token);
        // Validate token and extract payload
        const payload = await validateToken(token);
        // console.log('Token payload:', payload);

        return payload;
    } catch (error) {
        console.error('Error in validateJWT:', error);
        throw new JWTError('Invalid token ' + JSON.stringify(event.headers.cookie) + +(error as any).message);
    }
};