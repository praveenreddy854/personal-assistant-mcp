import 'dotenv/config';
import { z } from 'zod';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_URL: z.url(), COSMOS_ENDPOINT:z.url(), COSMOS_DATABASE:z.string().default('memory'),
    COSMOS_CONTAINER:z.string().default('vaults'), COSMOS_DIRECTORY_CONTAINER:z.string().default('identities'), COSMOS_KEY:z.string().optional(),
    AUTH_MODE: z.enum(['oidc', 'development', 'token']).default('oidc'),
    DEV_TOKEN: z.string().optional(), AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().optional(), AUTH_JWKS_URL: z.string().optional(),
    AUTHORIZATION_SERVER: z.string().optional(), AUTH_SCOPE: z.string().default('memory.access'),
    AUTH_REQUEST_SCOPE: z.string().optional(),
    ALLOWED_ORIGINS: z.string().default(''),
    AZURE_OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().optional(),
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().optional(),
    EMBEDDING_VERSION: z.string().default('memory-embedding-v1'),
    SERVING_ENABLED: z.enum(['true','false']).default('true'),
    AZURE_OPENAI_API_KEY: z.string().optional()
  });
  const c = schema.parse(env);
  const url = new URL(c.PUBLIC_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('PUBLIC_URL must use HTTPS outside localhost');
  if (c.AUTH_MODE === 'development') {
    if (c.NODE_ENV === 'production' || !local || !c.DEV_TOKEN || c.DEV_TOKEN.length < 32)
      throw new Error('Development authentication requires a local URL, non-production mode, and a 32+ character DEV_TOKEN');
  } else if (c.AUTH_MODE === 'oidc') {
    for (const key of ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTHORIZATION_SERVER'] as const)
      if (!c[key] && c.SERVING_ENABLED!=='false') throw new Error(`${key} is required for OIDC authentication`);
    for (const key of ['AUTH_ISSUER', 'AUTH_JWKS_URL', 'AUTHORIZATION_SERVER'] as const)
      if (c[key] && new URL(c[key]!).protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
  }
  const store=new URL(c.COSMOS_ENDPOINT),emulator=['localhost','127.0.0.1','[::1]'].includes(store.hostname);
  if(c.COSMOS_KEY&&(c.NODE_ENV==='production'||!emulator))throw new Error('COSMOS_KEY is supported only for the local emulator; Azure uses managed identity');
  if(store.protocol!=='https:'&&!emulator)throw new Error('COSMOS_ENDPOINT must use HTTPS outside localhost');
  return { ...c, PUBLIC_URL: c.PUBLIC_URL.replace(/\/$/, ''), cosmos:{endpoint:c.COSMOS_ENDPOINT,database:c.COSMOS_DATABASE,container:c.COSMOS_CONTAINER,directoryContainer:c.COSMOS_DIRECTORY_CONTAINER,key:c.COSMOS_KEY},servingEnabled:c.SERVING_ENABLED==='true' };
}
export type Config = ReturnType<typeof loadConfig>;
