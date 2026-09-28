import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';


const logoutUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Validate the user data
    if (!event || !event?.headers) {
        throw {
            message: 'Bad Request',
            status: 400,
        };
    }

    let cookies: string[] = [];
    if (event.headers && event.headers.Cookie) {
        // Split the "Cookie" header value by semicolon (;) to get individual cookies
        cookies = event.headers.Cookie.split(';');
    }

    // Filter out the cookie named "token" and create a new cookie string
    const newCookies = cookies
        .filter((cookie: string) => !cookie.trim().startsWith('token='))
        .map((cookie: string) => cookie.trim())
        .join('; ');

    // Create a response with a "Set-Cookie" header to clear the "token" cookie
    const response = {
        statusCode: 200,
        headers: {
            'Set-Cookie': `token=; Max-Age=0; Path=/; HttpOnly;`,
            'Content-Type': 'text/plain',
        },
        body: `Cleared cookie named "token". Updated cookies: ${newCookies}`,
    };

    return response;

}

export default logoutUser;