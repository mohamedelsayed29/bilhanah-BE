import { Controller, HttpCode, HttpStatus, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type ImageSet, MEDIA_MAX_BYTES, uploadMediaQuerySchema } from '@bilhanah/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { MediaService } from './media.service.js';

@Controller('media')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
/** Images for the menu (menu.manage) and the restaurant's branding (settings.manage). */
@RequireAnyPermission('menu.manage', 'settings.manage')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** multipart/form-data with one `file` field; `?kind=ITEM|LOGO|COVER`. Larger files get 413. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'media-upload:ip', limit: 120, windowSeconds: 60 * 60, by: 'ip' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 0 } }))
  upload(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(uploadMediaQuerySchema)) query: z.output<typeof uploadMediaQuerySchema>,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ): Promise<ImageSet> {
    return this.media.upload(auth.userId, query.kind, file?.buffer);
  }
}
