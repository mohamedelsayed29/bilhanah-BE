import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { SecretBox } from './secret-box.js';

export function secretBoxFrom(config: ConfigService<Env, true>): SecretBox {
  // A dedicated key is preferred; deriving from the JWT secret means rotating it
  // would also require re-enrolling administrators' authenticators.
  return new SecretBox(config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true }));
}

@Global()
@Module({
  providers: [{ provide: SecretBox, inject: [ConfigService], useFactory: secretBoxFrom }],
  exports: [SecretBox],
})
export class CryptoModule {}
