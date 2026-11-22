import { useEffect, useState } from 'react';
import homeIcon from '../assets/material-icons/home-button.svg';
import upIcon from '../assets/material-icons/up-arrow-key.svg';
import folderIcon from '../assets/material-icons/folder-symbol.svg';
import fileIcon from '../assets/material-icons/google-drive-file.svg';
import favoriteIcon from '../assets/material-icons/mark-as-favorite-star.svg';
import { useI18n } from '../i18n-context';
import { useToast } from '../toast-context';

type FileEntry = {
    name: string;
    path: string;
    isDirectory: boolean;
    isStarred: boolean;
};

type FileListingResponse = {
    success: boolean;
    error?: string;
    currentPath?: string;
    parentPath?: string | null;
    contents?: FileEntry[];
};

export default function FilesPage() {
    const { t } = useI18n();
    const { toast } = useToast();
    const [currentPath, setCurrentPath] = useState('');
    const [parentPath, setParentPath] = useState<string | null>(null);
    const [contents, setContents] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function loadFiles() {
            const requestedPath = new URLSearchParams(window.location.search).get('path') || '';
            setCurrentPath(requestedPath);
            try {
                const url = requestedPath
                    ? `/api/files?path=${encodeURIComponent(requestedPath)}`
                    : '/api/files';
                const response = await fetch(url, { credentials: 'include' });
                const data = await response.json() as FileListingResponse;
                if (!response.ok || !data.success || !Array.isArray(data.contents)) {
                    throw new Error(data.error || 'Dateien konnten nicht geladen werden');
                }
                if (!cancelled) {
                    setCurrentPath(data.currentPath || '');
                    setParentPath(data.parentPath ?? null);
                    setContents(data.contents);
                }
            } catch (loadError) {
                if (!cancelled) {
                    setLoadFailed(true);
                    toast(loadError instanceof Error ? loadError.message : 'Dateien konnten nicht geladen werden', 'error');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void loadFiles();
        return () => {
            cancelled = true;
        };
    }, [toast]);

    const pathHref = (path: string) => path ? `/files?path=${encodeURIComponent(path)}` : '/files';

    return (
        <section className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-200">{t('Mitgliederbereich')}</p>
            <h1 className="theme-text mt-2 text-3xl font-semibold">{t('Dateien')}</h1>
            <p className="theme-muted mt-3">{t('Dateien und Ordner aus dem geschützten Tattyhost-Downloadverzeichnis.')}</p>
            {currentPath && <p className="theme-muted mt-5 break-all font-mono text-sm">/{currentPath}</p>}

            {loading ? (
                <p className="theme-muted mt-8" role="status">{t('Dateien werden geladen...')}</p>
            ) : (
                <div className="mt-8 space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        {parentPath !== null && (
                            <a className="theme-panel flex flex-1 items-center gap-3 rounded-xl border p-4 transition hover:border-sky-300/30" href={pathHref(parentPath)}>
                                <img aria-hidden="true" className="material-icon h-5 w-5 shrink-0" src={upIcon} alt="" />
                                <span className="theme-text">{t('Ein Verzeichnis nach oben')}</span>
                            </a>
                        )}
                        <a className="theme-panel flex flex-1 items-center gap-3 rounded-xl border p-4 transition hover:border-sky-300/30" href={pathHref('')}>
                            <img aria-hidden="true" className="material-icon h-5 w-5 shrink-0" src={homeIcon} alt="" />
                            <span className="theme-text">{t('Home')}</span>
                        </a>
                    </div>
                    {contents.map((entry) => (
                        <a
                            key={entry.path}
                            className="theme-panel flex min-w-0 items-center gap-3 rounded-xl border p-4 transition hover:border-sky-300/30"
                            href={entry.isDirectory ? pathHref(entry.path) : `/api/files/download?path=${encodeURIComponent(entry.path)}`}
                        >
                            <img
                                aria-hidden="true"
                                className="material-icon h-5 w-5 shrink-0"
                                src={entry.isDirectory ? folderIcon : fileIcon}
                                alt=""
                            />
                            <span className="theme-text min-w-0 flex-1 break-all">{entry.name}</span>
                            {entry.isStarred && <img className="material-icon h-4 w-4 shrink-0" src={favoriteIcon} alt={t('Favorit')} />}
                            {entry.isDirectory && <span className="theme-muted text-xs">{t('Ordner')}</span>}
                        </a>
                    ))}
                    {!loadFailed && contents.length === 0 && (
                        <p className="theme-panel theme-muted rounded-xl border p-5">{t('Dieser Ordner ist leer.')}</p>
                    )}
                </div>
            )}
        </section>
    );
}
