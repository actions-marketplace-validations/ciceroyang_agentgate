/**
 * Where the service listens when nothing says otherwise.
 *
 * This is a module and not a literal because three files have to agree on it: the CLI picks it,
 * the systemd unit sets it as an environment variable, and the Caddyfile proxies to it. A test
 * used to scrape "AGENTGATE_PORT || 8080" out of the CLI source to check that agreement, which
 * broke the moment the default was expressed differently -- and a scrape cannot tell the
 * difference between the default changing and the source being reworded.
 */
export const DEFAULT_PORT = 8080
export const DEFAULT_HOST = "127.0.0.1"
