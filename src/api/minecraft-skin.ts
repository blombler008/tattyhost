import { isCanonicalPlayerUuid } from './thn-player-contract.ts';

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Minecraft-Skin-Dienst nicht erreichbar');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error('Minecraft-Skin-Antwort zu groß');
            chunks.push(Buffer.from(value));
        }
    } finally {
        await reader.cancel();
    }
    return Buffer.concat(chunks);
}

export async function fetchMinecraftSkin(uuid: string, fetcher: typeof fetch = fetch): Promise<Buffer | null> {
    if (!isCanonicalPlayerUuid(uuid)) throw new Error('Ungültige Minecraft-UUID');
    const signal = AbortSignal.timeout(5000);
    const response = await fetcher(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, { signal, redirect: 'error' });
    const profile: unknown = JSON.parse((await readLimited(response, 128 * 1024)).toString('utf8'));
    if (!profile || typeof profile !== 'object' || !('id' in profile) || profile.id !== uuid.replace(/-/g, '') ||
        !('properties' in profile) || !Array.isArray(profile.properties)) throw new Error('Ungültiges Minecraft-Profil');
    const property: unknown = profile.properties.find((item: unknown) =>
        typeof item === 'object' && item !== null && 'name' in item && item.name === 'textures');
    if (!property) return null;
    if (typeof property !== 'object' || !('value' in property) || typeof property.value !== 'string') throw new Error('Ungültige Minecraft-Texturen');
    const textures: unknown = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8'));
    if (!textures || typeof textures !== 'object' || !('textures' in textures) || !textures.textures || typeof textures.textures !== 'object') throw new Error('Ungültige Minecraft-Texturen');
    if (!('SKIN' in textures.textures)) return null;
    const skin = textures.textures.SKIN;
    if (!skin || typeof skin !== 'object' || !('url' in skin) || typeof skin.url !== 'string') throw new Error('Ungültige Minecraft-Skin-Adresse');
    const url = new URL(skin.url);
    const match = /^\/texture\/([a-f0-9]{64})$/.exec(url.pathname);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || url.port || url.username || url.password || url.search || url.hash || !match) throw new Error('Ungültige Minecraft-Skin-Adresse');
    const image = await fetcher(`https://textures.minecraft.net/texture/${match[1]}`, { signal, redirect: 'error' });
    if (image.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
        await image.body?.cancel();
        throw new Error('Ungültiges Minecraft-Skin-Bild');
    }
    const bytes = await readLimited(image, 1024 * 1024);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Ungültiges Minecraft-Skin-Bild');
    return bytes;
}
