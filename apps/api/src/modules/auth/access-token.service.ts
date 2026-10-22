import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@bilhanah/contracts';
import { z } from 'zod';
import type { Env } from '../../config/env.schema.js';

export const JWT_ISSUER = 'bilhanah-api';
export const JWT_AUDIENCE = 'bilhanah-dashboard';

const claimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  role: z.enum(['OWNER', 'ADMIN']),
});
export type AccessTokenClaims = z.infer<typeof claimsSchema>;

@Injectable()
export class AccessTokenService {
  readonly ttlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
  }

  sign(userId: string, sessionId: string, role: UserRole): Promise<string> {
    return this.jwt.signAsync({ sid: sessionId, role }, { subject: userId, expiresIn: this.ttlSeconds });
  }

  /** Returns the claims of a valid token, or null. */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const payload: unknown = await this.jwt.verifyAsync(token);
      const result = claimsSchema.safeParse(payload);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
