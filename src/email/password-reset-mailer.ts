import nodemailer from 'nodemailer';

type SmtpSettings = {
    host: string;
    port: number;
    secure: boolean;
    from: string;
    user?: string;
    password?: string;
};

function getSmtpSettings(): SmtpSettings | null {
    const host = process.env.SMTP_HOST?.trim();
    const from = process.env.MAIL_FROM?.trim();
    const portValue = process.env.SMTP_PORT || '587';
    const port = Number(portValue);
    const user = process.env.SMTP_USER?.trim();
    const password = process.env.SMTP_PASSWORD;
    const secureValue = process.env.SMTP_SECURE?.toLowerCase();

    if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535 ||
        Boolean(user) !== Boolean(password) ||
        (secureValue !== undefined && secureValue !== 'true' && secureValue !== 'false')) {
        return null;
    }

    return {
        host,
        port,
        secure: secureValue === undefined ? port === 465 : secureValue === 'true',
        from,
        ...(user && password ? { user, password } : {})
    };
}

export function isSmtpConfigured(): boolean {
    return getSmtpSettings() !== null;
}

export async function sendPasswordResetEmail(to: string, username: string, resetUrl: string): Promise<void> {
    const settings = getSmtpSettings();
    if (!settings) {
        throw new Error('SMTP password-reset mail settings are missing or invalid');
    }

    const transporter = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        requireTLS: !settings.secure,
        tls: { minVersion: 'TLSv1.2' },
        ...(settings.user && settings.password
            ? { auth: { user: settings.user, pass: settings.password } }
            : {})
    });
    const safeUsername = username.replace(/[\r\n]/g, ' ').slice(0, 64);

    await transporter.sendMail({
        from: settings.from,
        to,
        subject: 'Tattyhost Passwort zurücksetzen',
        text: `Hallo ${safeUsername},\n\nüber diesen Link kannst du dein Tattyhost-Passwort innerhalb der nächsten Stunde zurücksetzen:\n\n${resetUrl}\n\nWenn du diese Änderung nicht angefordert hast, kannst du diese E-Mail ignorieren.`
    });
}
