import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n-context';
import checkIcon from '../assets/material-icons/check-symbol.svg';
import clockIcon from '../assets/material-icons/clock-with-white-face.svg';
import playerIcon from '../assets/material-icons/user-outline.svg';
import gameIcon from '../assets/material-icons/gamepad.svg';
import timeIcon from '../assets/material-icons/history-clock-button.svg';
import heartIcon from '../assets/material-icons/favorite-heart-outline-button.svg';
import starIcon from '../assets/material-icons/rate-star-button.svg';

export type AccountPlayerStats = {
    name: string;
    online: boolean;
    lastSeen: number;
    playtimeTicks: number;
    deaths: number;
    mobKills: number;
    playerKills: number;
    serverName?: string | null;
};

type Props = {
    name: string;
    uuid: string;
    verified: boolean;
    stats: AccountPlayerStats | null | undefined;
    skinUrl: string;
    children: ReactNode;
    notice?: ReactNode;
};

export default function MinecraftAccountCard({ name, uuid, verified, stats, skinUrl, children, notice }: Props) {
    const { t, language } = useI18n();
    const [skinFailed, setSkinFailed] = useState(false);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 15000);
        return () => window.clearInterval(timer);
    }, []);

    const online = stats && stats.online && now - stats.lastSeen <= 90000;
    const metrics = stats ? [
        { label: t('Spielzeit'), value: t('{hours} Std. {minutes} Min.', { hours: Math.floor(stats.playtimeTicks / 72000), minutes: Math.floor(stats.playtimeTicks / 1200) % 60 }), icon: clockIcon },
        { label: t('Zuletzt gesehen'), value: new Date(stats.lastSeen).toLocaleString(language === 'de' ? 'de-DE' : 'en-US'), icon: timeIcon },
        { label: t('Tode'), value: stats.deaths, icon: heartIcon },
        { label: t('Monster-Kills'), value: stats.mobKills, icon: gameIcon },
        { label: t('Spieler-Kills'), value: stats.playerKills, icon: starIcon }
    ] : [];
    return <article className="theme-input rounded-2xl border p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
                <div className="theme-subsection relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border" title={skinFailed ? t('Minecraft-Skin nicht verfügbar') : t('Minecraft-Skin')}>
                    {skinFailed ? <img className="material-icon m-3 h-6 w-6" src={playerIcon} alt="" /> : <>
                        <img src={skinUrl} alt="" onError={() => setSkinFailed(true)} className="absolute max-w-none" style={{ width: 384, left: -48, top: -48, imageRendering: 'pixelated' }} />
                        <img src={skinUrl} alt="" className="absolute max-w-none" style={{ width: 384, left: -240, top: -48, imageRendering: 'pixelated' }} />
                    </>}
                </div>
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="theme-text break-all font-semibold">{name}</h3><span className="theme-muted inline-flex flex-wrap items-center gap-1.5 text-xs"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${stats ? online ? 'bg-emerald-500' : 'bg-slate-400' : 'bg-amber-500'}`} />{stats ? t(online ? 'Jetzt online' : 'Offline') : t('Status unbekannt')}{online && stats.serverName && <span>· {stats.serverName}</span>}</span></div><p className="theme-muted mt-1 break-all font-mono text-xs">{uuid}</p></div>
            </div>
            <span className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${verified ? 'verification-badge' : 'verification-pending'}`}>
                {verified ? <span className="h-4 w-4 bg-emerald-600" style={{ maskImage: `url("${checkIcon}")`, maskPosition: 'center', maskRepeat: 'no-repeat', maskSize: 'contain' }} aria-hidden="true" /> : <img className="material-icon h-4 w-4" src={clockIcon} alt="" />}
                {t(verified ? 'Verifiziert' : 'Verifizierung ausstehend')}
            </span>
        </div>
        {notice}
        {stats ? <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">{metrics.map((metric) => <div key={metric.label} className="theme-subsection rounded-xl border p-3"><dt className="theme-muted flex items-center gap-2 text-xs"><img src={metric.icon} className="material-icon h-4 w-4" alt="" />{metric.label}</dt><dd className="theme-text mt-2 break-words text-sm font-semibold">{metric.value}</dd></div>)}</dl> : stats === null && <p className="theme-muted mt-4 text-sm">{t('Noch keine Spielerstatistik vorhanden')}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">{children}</div>
    </article>;
}
