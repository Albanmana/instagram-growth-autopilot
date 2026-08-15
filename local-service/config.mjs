const LOOPBACK_HOST = "127.0.0.1";
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function requiredString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

export function loadServiceConfig(environment = process.env) {
  const host = environment.FOLLOWUP_SERVICE_HOST || LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) throw new Error("FOLLOWUP_SERVICE_HOST must be 127.0.0.1.");

  const port = Number(environment.FOLLOWUP_SERVICE_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("FOLLOWUP_SERVICE_PORT must be a valid local port.");
  }

  const pairingToken = requiredString(environment, "FOLLOWUP_PAIRING_TOKEN");
  if (!PAIRING_TOKEN_PATTERN.test(pairingToken)) {
    throw new Error("A 32-character pairing token is required.");
  }

  const supabaseUrl = requiredString(environment, "FOLLOWUP_SUPABASE_URL");
  const parsedUrl = new URL(supabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)) {
    throw new Error("FOLLOWUP_SUPABASE_URL must target local Supabase.");
  }

  return {
    host,
    port,
    supabaseUrl,
    supabaseServiceRoleKey: requiredString(environment, "FOLLOWUP_SUPABASE_SERVICE_ROLE_KEY"),
    pairingToken,
  };
}
