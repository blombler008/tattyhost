export function isValidEmail(email: string): boolean {
    return email.length <= 128 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

export function getPasswordResetUrl(token: string): string | null {
    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    if (!appBaseUrl) return null;

    try {
        const baseUrl = new URL(appBaseUrl);
        if ((baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') ||
            (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')) {
            return null;
        }
        const resetUrl = new URL('/reset-password', baseUrl);
        resetUrl.hash = new URLSearchParams({ token }).toString();
        return resetUrl.toString();
    } catch {
        return null;
    }
}
