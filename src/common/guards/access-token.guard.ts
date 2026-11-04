import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AUTH_ERROR_CODES, effectivePermissions } from '@bilhanah/contracts';
import type { Request } from 'express';
import { AccessTokenService } from '../../modules/auth/access-token.service.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { AuthContext } from '../decorators/current-auth.decorator.js';

function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException({
    code: AUTH_ERROR_CODES.UNAUTHENTICATED,
    message: 'Sign in to continue.',
  });
}

/**
 * Requires `Authorization: Bearer <access token>`. Besides the signature, the
 * session and account are checked on every request, so logout, password
 * reset and suspension take effect immediately rather than at token expiry.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw unauthenticated();

    const claims = await this.accessTokens.verify(token);
    if (!claims) throw unauthenticated();

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { role: true, status: true, permissionGrants: true } } },
    });
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE'
    ) {
      throw unauthenticated();
    }

    request.auth = {
      userId: claims.sub,
      sessionId: claims.sid,
      role: session.user.role,
      permissions: new Set(effectivePermissions(session.user.role, session.user.permissionGrants)),
    };
    return true;
  }
}
