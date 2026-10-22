import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@bilhanah/contracts';

export type AuthContext = {
  userId: string;
  sessionId: string;
  role: UserRole;
};

/** The authenticated caller set by AccessTokenGuard. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<{ auth: AuthContext }>().auth,
);
