export interface WorkerEnv {
  MOTION: DurableObjectNamespace;
  MOTION_API_KEY: string;
  MOTION_ACCOUNT_ID: string;
  MOTION_USER_ID: string;
  MOTION_WORKSPACE_IDS: string; // required remotely: CSV of allowed workspaces
  MOTION_ASSIGNEE_IDS: string; // required remotely: CSV, normally only the owner
  MOTION_DISABLED_TOOLS?: string; // CSV kill switch, merged with the built-in disabled set
  MOTION_STATUS_MAP?: string;
  MOTION_RATE_LIMIT_PER_MINUTE?: string;
  ACCESS_TEAM_DOMAIN: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD: string; // Application Audience tag, 64 hex characters
  ACCESS_ALLOWED_EMAIL: string;
  ACCESS_DEV_JWK?: string; // read only by src/worker/dev-entry.ts; production refuses to start if set
}
