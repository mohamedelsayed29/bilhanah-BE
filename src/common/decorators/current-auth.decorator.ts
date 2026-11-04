import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, UserRole } from '@bilhanah/contracts';

export type AuthContext = {
  userId: string;
  sessionId: string;
  role: UserRole;
  /** What the account may do in its restaurant, from its role and grants (empty for administrators). */
  permissions: ReadonlySet<Permission>;
};

/** The authenticated caller set by AccessTokenGuard. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<{ auth: AuthContext }>().auth,
);
