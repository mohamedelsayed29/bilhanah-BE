import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import type { Env } from '../../config/env.schema.js';
import { AccessTokenService, JWT_AUDIENCE, JWT_ISSUER } from './access-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        verifyOptions: { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, AccessTokenService, AccessTokenGuard],
  // Other modules import AuthModule to protect routes with AccessTokenGuard.
  exports: [AccessTokenService, AccessTokenGuard, PasswordService],
})
export class AuthModule {}
