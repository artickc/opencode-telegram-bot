/**
 * OpenCode session id matching for Telegram callback_data.
 *
 * OpenCode ids look like `ses_0be2a1e12ffeFK0p10n7XJH7nz` (~30 chars of
 * alphanumerics + underscore). Older UUID-style ids are also accepted so
 * callbacks stay compatible across backends.
 *
 * Capture group 1 is the full session id. Keep this in one place — every
 * `run:*` / `sess:` / `hist:` / `watch:` / `killsess:*` handler must use it,
 * otherwise buttons silently no-op (grammY never matches the callback).
 */
export const SESSION_ID = "([A-Za-z0-9_-]{8,64})";
