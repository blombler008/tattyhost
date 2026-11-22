export type FileListingRules = {
    filter: string[];
    star: string[];
};

export const DEFAULT_FILE_LISTING_RULES: FileListingRules = {
    filter: [
        '\\.s#?[1-9]$',
        '\\.b#?[1-9]$',
        '\\.b#?#$',
        '^~\\$',
        '2022',
        '.sync*',
        'Desktop.ini',
        'filter\\.json'
    ],
    star: ['Tim', 'tmux.pdf', 'Stefan']
};
