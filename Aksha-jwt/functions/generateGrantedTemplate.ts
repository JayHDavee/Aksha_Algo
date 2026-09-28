const generateGrantedTemplate = ({email, scopes, message} : {email?: string, scopes?: string[], message: string}) => {
    return `
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fabric User Scopes</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
        <tr>
            <td style="padding: 20px;">
                <h1 style="color: #333;">Fabric User Scopes</h1>
                <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                        <td style="padding-bottom: 10px;">
                            <strong style="color: #555;">Message:</strong> ${message}
                        </td>
                    </tr>
                    ${
                        email
                            ? `
                    <tr>
                        <td style="padding-bottom: 10px;">
                            <strong style="color: #555;">Email:</strong> ${email}
                        </td>
                    </tr>
                    `
                            : ``
                    }
                    ${
                        scopes && scopes.length > 0
                            ? `
                    <tr>
                        <td>
                            <strong style="color: #555;">Existing Scopes:</strong>
                            <ul style="list-style-type: none; padding-left: 20px;">
                                ${scopes.map((scope) => `<li>${scope}</li>`).join(' ')}
                            </ul>
                        </td>
                    </tr>
                    `
                            : ``
                    }
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
  `;
};

export default generateGrantedTemplate;