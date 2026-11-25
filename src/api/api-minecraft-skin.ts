import type { Request, Response } from 'express';
import { query } from '@tattyhost/SQLutils';
import { logApiFailure, requireAdmin, requireUser, sendFailure } from './api-shared.ts';
import { fetchMinecraftSkin } from './minecraft-skin.ts';
import { isCanonicalPlayerUuid } from './thn-player-contract.ts';

async function accountExists(userId: string, playerUuid: string): Promise<boolean> {
    const accounts = await query<{ player_uuid: string }>(
        'SELECT player_uuid FROM user_minecraft_accounts WHERE user_uuid = ? AND player_uuid = ?',
        [userId, playerUuid]
    );
    return accounts.length > 0;
}

async function sendAccountSkin(res: Response, userId: string, playerUuid: string, lookup = accountExists, loadSkin = fetchMinecraftSkin) {
    if (!isCanonicalPlayerUuid(playerUuid)) {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }
    try {
        if (!await lookup(userId, playerUuid)) {
            sendFailure(res, 404, 'Minecraft-Konto nicht gefunden');
            return;
        }
        const skin = await loadSkin(playerUuid);
        if (!skin) {
            sendFailure(res, 404, 'Kein eigener Minecraft-Skin verfügbar');
            return;
        }
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.type('png').send(skin);
    } catch (error) {
        logApiFailure(res, 'api.minecraft.skin_load_failed', error);
        sendFailure(res, 502, 'Minecraft-Skin konnte nicht geladen werden');
    }
}

export function createOwnSkinHandler(lookup = accountExists, loadSkin = fetchMinecraftSkin) {
    return async (req: Request, res: Response) => {
        const user = requireUser(res);
        if (user) await sendAccountSkin(res, user.userId, req.params.uuid, lookup, loadSkin);
    };
}

export const getOwnSkin = createOwnSkinHandler();

export async function getAdminSkin(req: Request, res: Response) {
    if (requireAdmin(res)) await sendAccountSkin(res, String(req.params.uuid), req.params.playerUuid);
}
