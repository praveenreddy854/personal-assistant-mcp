import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Actor } from './models.js';
import type { Config } from './config.js';
import { MemoryError, requireThat } from './errors.js';
import { memberActor } from './db.js';

export function authenticator(config: Config,verificationKeys?:JWTVerifyGetKey,hasGrant?:(actor:Actor)=>Promise<boolean>): (request: Request) => Promise<Actor> {
  const keys = config.AUTH_MODE === 'oidc' && config.AUTH_JWKS_URL ? verificationKeys??createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;
  return async request => {
    requireThat(config.servingEnabled,'serving_paused','Memory serving is paused for initialization or restore verification.',503);
    const token = /^Bearer (\S+)$/i.exec(request.header('Authorization') ?? '')?.[1];
    if (!token) throw new MemoryError('unauthorized','Connect this client using OAuth before accessing memory.',401);
    if (config.AUTH_MODE === 'development') {
      const actual = Buffer.from(token), expected = Buffer.from(config.DEV_TOKEN!);
      requireThat(actual.length === expected.length && timingSafeEqual(actual,expected),'unauthorized','Invalid local development token.',401);
      return { issuer:'local-development',subject:'local-user',clientId:'local-client' };
    }
    // Personal family tokens: reject unknown/revoked tokens before any (billable) work; vault access re-checks.
    if (config.AUTH_MODE === 'token') {
      const actor = memberActor(token);
      requireThat(hasGrant && await hasGrant(actor),'unauthorized','Unknown or revoked family token.',401);
      return actor;
    }
    try {
      const { payload } = await jwtVerify(token,keys!,{ issuer:config.AUTH_ISSUER!,audience:config.AUTH_AUDIENCE!,algorithms:['RS256'],clockTolerance:5,requiredClaims:['sub','exp','iat'] });
      requireThat(typeof payload.scp === 'string' && payload.scp.split(' ').includes(config.AUTH_SCOPE),'insufficient_scope','The token does not grant memory access.',403);
      // Entra oid is stable across client registrations; sub can be pairwise.
      const subject = typeof payload.oid === 'string' ? payload.oid : payload.sub!;
      const clientId = typeof payload.azp === 'string' ? payload.azp : typeof payload.client_id === 'string' ? payload.client_id : undefined;
      requireThat(clientId,'unauthorized','The token must identify its OAuth client.',401);
      return { issuer:payload.iss!,subject,clientId };
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError('unauthorized','The access token could not be verified.',401);
    }
  };
}
