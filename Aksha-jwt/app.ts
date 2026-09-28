import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import registerUser   from './routes/registerUser';
import loginUser      from './routes/loginUser';
import logoutUser     from './routes/logoutUser';
import resetPass      from './routes/resetPass';
import contact        from './routes/akshaWebPageContact';
import updateEmail    from './routes/updateEmail';

// ── Mobile routes ──────────────────────────
import registerMobileUser from './routes/registerMobileUser';
import loginMobileUser    from './routes/loginMobileUser';
import logoutMobileUser   from './routes/logoutMobileUser';
import getMobileUsers     from './routes/getMobileUsers';
import getGroups          from './routes/getGroups';
import addGroups          from './routes/addGroups';
import updateGroups       from './routes/updateGroups';
import deleteMobileUser   from './routes/deleteMobileUser';
import updateMobileUser   from './routes/updateMobileUser';
import getAlerts          from './routes/getAlerts';
import getHealthSettings    from './routes/getHealthSettings';
import updateHealthSettings from './routes/updateHealthSettings';
import { JWTError } from './middleware/validateJWT';

// Exact-match helper — avoids substring collision (e.g. /mobile-users matching /mobile)
const route = (path: string, pattern: string): boolean =>
    path === pattern || path.endsWith(pattern);

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {

        // ── CORS preflight ─────────────────────────────────────────
        if (event.httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin':  '*',
                    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                },
                body: '',
            };
        }

        console.log('Event Path:', event.path);
        console.log('Env:', process.env);

        let res: APIGatewayProxyResult | null = null;

        // ── IMPORTANT: mobile routes MUST come before generic routes ──
        // /mobile/register contains /register — order matters

        if (route(event.path, '/mobile-users')) {
            console.log('Routing to /mobile-users');
            res = await getMobileUsers(event);

        } else if (event.path.includes('/mobile/alerts/')) {
            console.log('Routing to /mobile/alerts/{groupId}');
            res = await getAlerts(event);

        } else if (route(event.path, '/mobile/register')) {
            console.log('Routing to /mobile/register');
            res = await registerMobileUser(event);

        } else if (route(event.path, '/mobile/login')) {
            console.log('Routing to /mobile/login');
            res = await loginMobileUser(event);

        } else if (route(event.path, '/mobile/logout')) {
            console.log('Routing to /mobile/logout');
            res = await logoutMobileUser(event);

        } else if (route(event.path, '/mobile/get-groups')) {
            console.log('Routing to /mobile/get-groups');
            res = await getGroups(event);

        } else if (route(event.path, '/mobile/add-groups')) {
            console.log('Routing to /mobile/add-groups');
            res = await addGroups(event);

        } else if (route(event.path, '/mobile/update-groups')) {
            console.log('Routing to /mobile/update-groups');
            res = await updateGroups(event);

        } else if (route(event.path, '/mobile/delete')) {
            console.log('Routing to /mobile/delete');
            res = await deleteMobileUser(event);

        } else if (route(event.path, '/mobile/update')) {
            console.log('Routing to /mobile/update');
            res = await updateMobileUser(event);

        } else if (route(event.path, '/register')) {
            console.log('Routing to /register');
            res = await registerUser(event);

        } else if (route(event.path, '/login')) {
            console.log('Routing to /login');
            res = await loginUser(event);

        } else if (route(event.path, '/logout')) {
            console.log('Routing to /logout');
            res = await logoutUser(event);

        } else if (route(event.path, '/hello')) {
            console.log('Routing to /hello');
            res = {
                statusCode: 200,
                body: JSON.stringify({ message: 'hello world' }),
            };

        } else if (route(event.path, '/reset-password')) {
            console.log('Routing to /reset-password');
            res = await resetPass(event);
            res.headers = {
                ...res?.headers,
                'Content-Type': 'text/html',
            };

        } else if (route(event.path, '/contact')) {
            console.log('Routing to /contact');
            res = await contact(event);

        } else if (route(event.path, '/update-email')) {
            console.log('Routing to /update-email');
            res = await updateEmail(event);

        } else if (route(event.path, '/health/settings') && event.httpMethod === 'GET') {
            console.log('Routing to GET /health/settings');
            res = await getHealthSettings(event);

        } else if (route(event.path, '/health/settings') && event.httpMethod === 'PUT') {
            console.log('Routing to PUT /health/settings');
            res = await updateHealthSettings(event);

        } else {
            console.log('Invalid path accessed');
            res = {
                statusCode: 404,
                body: JSON.stringify({ message: 'Path not found' }),
            };
        }

        // ── Add CORS headers to all responses ──────────────────────
        res.headers = {
            ...res?.headers,
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        };

        return res;

    } catch (err) {
        console.log('Error in lambdaHandler:', err);

        if (err instanceof JWTError) {
            return {
                statusCode: 401,
                headers: {
                    'Access-Control-Allow-Origin':      process.env.CLIENT_ORIGIN || '*',
                    'Access-Control-Allow-Credentials': 'true',
                    'Access-Control-Allow-Methods':     'GET,POST,PUT,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers':     'Content-Type,Authorization',
                },
                body: JSON.stringify({ message: 'Unauthorized: ' + err.message }),
            };
        }

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin':      process.env.CLIENT_ORIGIN || '*',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Methods':     'GET,POST,PUT,DELETE,OPTIONS',
                'Access-Control-Allow-Headers':     'Content-Type,Authorization',
            },
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};   