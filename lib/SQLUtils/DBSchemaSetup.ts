// === DBSchemaSetup.ts ===
// Hinweis: Diese Datei setzt voraus, dass die Ziel-Datenbank bereits existiert.
// Die Funktionen definieren lediglich das Schema (Tabellenstruktur) innerhalb der Datenbank.
// Achte darauf, dass die Verbindungskonfiguration (z. B. Host, Benutzer, Passwort, Datenbankname)
// korrekt gesetzt ist, bevor `setupAllTables()` ausgeführt wird.
import { execute } from './SQLUtils';
import { DEFAULT_FILE_LISTING_RULES } from './FileListingDefaults';

export async function setupUsersTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS users (
            uuid CHAR(36) PRIMARY KEY,
            username VARCHAR(64) UNIQUE NOT NULL,
            email VARCHAR(128) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            has_cloud_access BOOLEAN NOT NULL DEFAULT FALSE,
            has_file_access BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS has_cloud_access BOOLEAN NOT NULL DEFAULT FALSE');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS has_file_access BOOLEAN NOT NULL DEFAULT FALSE');
}

export async function setupSessionsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS sessions (
            id VARCHAR(128) PRIMARY KEY,
            user_uuid CHAR(36) NOT NULL,
            ip_address VARCHAR(64),
            user_agent TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
        );
    `);
}

export async function setupPasswordResetTokensTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token_hash CHAR(64) PRIMARY KEY,
            user_uuid CHAR(36) NOT NULL UNIQUE,
            created_by CHAR(36),
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(uuid) ON DELETE SET NULL,
            INDEX idx_password_reset_expires_at (expires_at)
        );
    `);
}

export async function setupPasskeysTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS passkeys (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_uuid CHAR(36) NOT NULL,
            credential_id VARCHAR(255) UNIQUE NOT NULL,
            public_key TEXT NOT NULL,
            sign_count INT DEFAULT 0,
            transports TEXT,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
        );
    `);
}

export async function setupLoginAttemptsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS login_attempts (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_uuid CHAR(36),
            ip_address VARCHAR(64),
            success BOOLEAN NOT NULL,
            attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
}

export async function setupAuditLogsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_uuid CHAR(36),
            action VARCHAR(128) NOT NULL,
            details TEXT,
            request_id CHAR(36),
            target_type VARCHAR(64),
            target_id VARCHAR(128),
            logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id CHAR(36)');
    await execute('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_type VARCHAR(64)');
    await execute('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id VARCHAR(128)');
}

export async function setupApplicationLogsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS application_logs (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            request_id CHAR(36),
            log_level VARCHAR(16) NOT NULL,
            event_name VARCHAR(128) NOT NULL,
            method VARCHAR(16),
            route VARCHAR(255),
            status_code SMALLINT UNSIGNED,
            duration_ms INT UNSIGNED,
            user_uuid CHAR(36),
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_application_logs_created_at (created_at),
            INDEX idx_application_logs_event (event_name),
            INDEX idx_application_logs_request_id (request_id)
        );
    `);
}

export async function setup2FABackupsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS twofa_backups (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_uuid CHAR(36) NOT NULL,
            backup_code VARCHAR(255) NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
        );
    `);
}

export async function setupRolesTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS roles (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(64) UNIQUE NOT NULL,
            description TEXT
        );
    `);
    await execute(
        `INSERT IGNORE INTO roles (name, description)
         VALUES ('user', 'Standard user'), ('supporter', 'Supporter'),
                ('moderator', 'Moderator'), ('admin', 'Administrator')`
    );
}

export async function setupPermissionsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS permissions (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(64) UNIQUE NOT NULL,
            description TEXT
        );
    `);
}

export async function setupUserRolesTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS user_roles (
            user_uuid CHAR(36) NOT NULL,
            role_id INT NOT NULL,
            PRIMARY KEY (user_uuid, role_id),
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE,
            FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
        );
    `);
}

export async function setupRolePermissionsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_id INT NOT NULL,
            permission_id INT NOT NULL,
            PRIMARY KEY (role_id, permission_id),
            FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
            FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
        );
    `);
}

export async function setupUserSettingsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS user_settings (
            user_uuid CHAR(36) PRIMARY KEY,
            language VARCHAR(32) DEFAULT 'en',
            timezone VARCHAR(64) DEFAULT 'UTC',
            dark_mode BOOLEAN DEFAULT TRUE,
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
        );
    `);
}

export async function setupDownloadsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS downloads (
            id INT PRIMARY KEY AUTO_INCREMENT,
            title VARCHAR(128) NOT NULL,
            description TEXT,
            url VARCHAR(2048) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            storage_key CHAR(36) NULL,
            original_filename VARCHAR(255) NULL,
            created_by CHAR(36),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute('ALTER TABLE downloads ADD COLUMN IF NOT EXISTS storage_key CHAR(36) NULL');
    await execute('ALTER TABLE downloads ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255) NULL');
}

export async function setupDownloadUploadSettingsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS download_upload_settings (
            id TINYINT UNSIGNED PRIMARY KEY,
            max_upload_mb SMALLINT UNSIGNED NOT NULL DEFAULT 16,
            updated_by CHAR(36),
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (updated_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute(
        'INSERT IGNORE INTO download_upload_settings (id, max_upload_mb) VALUES (1, 16)'
    );
}

export async function setupFileListingSettingsTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS file_listing_settings (
            id TINYINT UNSIGNED PRIMARY KEY,
            filter_patterns TEXT NOT NULL,
            star_patterns TEXT NOT NULL,
            updated_by CHAR(36),
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (updated_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute(
        `INSERT IGNORE INTO file_listing_settings (id, filter_patterns, star_patterns)
         VALUES (1, ?, ?)`,
        [
            JSON.stringify(DEFAULT_FILE_LISTING_RULES.filter),
            JSON.stringify(DEFAULT_FILE_LISTING_RULES.star)
        ]
    );
}

export async function setupServiceStatusTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS service_status (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(64) UNIQUE NOT NULL,
            address VARCHAR(255) NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'maintenance',
            details VARCHAR(255) NOT NULL DEFAULT '',
            players_online INT UNSIGNED NULL,
            players_max INT UNSIGNED NULL,
            minecraft_version VARCHAR(32) NULL,
            sort_order INT NOT NULL DEFAULT 0,
            updated_by CHAR(36),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (updated_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS last_reported_at TIMESTAMP NULL');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS manual_override BOOLEAN NOT NULL DEFAULT FALSE');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS whitelist_revision BIGINT UNSIGNED NOT NULL DEFAULT 0');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS whitelist_required BOOLEAN NOT NULL DEFAULT FALSE');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS players_online INT UNSIGNED NULL');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS players_max INT UNSIGNED NULL');
    await execute('ALTER TABLE service_status ADD COLUMN IF NOT EXISTS minecraft_version VARCHAR(32) NULL');
}

export async function setupServiceWhitelistTables() {
    await execute(`
        CREATE TABLE IF NOT EXISTS service_whitelist_players (
            service_id INT NOT NULL,
            player_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            player_name VARCHAR(16) NOT NULL,
            approved_by CHAR(36),
            approved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (service_id, player_uuid),
            FOREIGN KEY (service_id) REFERENCES service_status(id) ON DELETE CASCADE,
            FOREIGN KEY (approved_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute(`
        CREATE TABLE IF NOT EXISTS service_whitelist_requests (
            id INT PRIMARY KEY AUTO_INCREMENT,
            service_id INT NOT NULL,
            player_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            player_name VARCHAR(16) NOT NULL,
            reason VARCHAR(500) NOT NULL DEFAULT '',
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            requested_by CHAR(36),
            reviewed_by CHAR(36),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_service_whitelist_request_player (service_id, player_uuid),
            INDEX idx_service_whitelist_requests_status (service_id, status, created_at),
            FOREIGN KEY (service_id) REFERENCES service_status(id) ON DELETE CASCADE,
            FOREIGN KEY (requested_by) REFERENCES users(uuid) ON DELETE SET NULL,
            FOREIGN KEY (reviewed_by) REFERENCES users(uuid) ON DELETE SET NULL
        );
    `);
    await execute("ALTER TABLE service_whitelist_requests ADD COLUMN IF NOT EXISTS reason VARCHAR(500) NOT NULL DEFAULT '' AFTER player_name");
    await execute(`
        CREATE TABLE IF NOT EXISTS user_minecraft_accounts (
            user_uuid CHAR(36) NOT NULL,
            player_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            player_name VARCHAR(16) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_uuid, player_uuid),
            FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
        );
    `);
}

export async function setupServiceStatusServiceApiKeysTable() {
    await execute(`
        CREATE TABLE IF NOT EXISTS service_status_service_api_keys (
            service_id INT PRIMARY KEY,
            token_hash CHAR(64) NOT NULL,
            created_by CHAR(36),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (service_id) REFERENCES service_status(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(uuid) ON DELETE SET NULL,
            UNIQUE KEY uq_service_status_service_api_keys_token_hash (token_hash)
        );
    `);
}

export async function setupAllTables() {
    await setupUsersTable();
    await setupSessionsTable();
    await setupPasswordResetTokensTable();
    await setupPasskeysTable();
    await setupLoginAttemptsTable();
    await setupAuditLogsTable();
    await setupApplicationLogsTable();
    await setup2FABackupsTable();
    await setupRolesTable();
    await setupPermissionsTable();
    await setupUserRolesTable();
    await setupRolePermissionsTable();
    await setupUserSettingsTable();
    await setupDownloadsTable();
    await setupDownloadUploadSettingsTable();
    await setupFileListingSettingsTable();
    await setupServiceStatusTable();
    await setupServiceStatusServiceApiKeysTable();
    await setupServiceWhitelistTables();
}
