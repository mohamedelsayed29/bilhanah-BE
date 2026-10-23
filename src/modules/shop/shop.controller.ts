import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AdminStandOrder,
  idempotencyKeySchema,
  type Paginated,
  placeStandOrderSchema,
  type PlaceStandOrderResponse,
  type PublicStandOrder,
  type ShopInfo,
  type ShopSettings,
  shopSettingsSchema,
  STAND_LIMITS,
  type StandOrderCheckout,
  standOrderIdParamSchema,
  standOrdersQuerySchema,
  updateStandOrderSchema,
  updateStandOrderStatusSchema,
  type UploadedLogo,
} from '@bilhanah/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireRole, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ShopService } from './shop.service.js';
import { StandOrdersService } from './stand-orders.service.js';

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);
const idParam = new ZodValidationPipe(standOrderIdParamSchema);
// The same bucket as the rest of the admin console.
const WRITE_LIMIT = { name: 'admin-write:ip', limit: 300, windowSeconds: 60, by: 'ip' } as const;

/** The stand shop's checkout: customers need no account. */
@Controller('public/shop')
@UseGuards(RateLimitGuard)
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'shop-info:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  info(): Promise<ShopInfo> {
    return this.shop.info();
  }

  /** multipart/form-data with one `file` field. */
  @Post('logos')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'shop-logo:ip', limit: 40, windowSeconds: 60 * 60, by: 'ip' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: STAND_LIMITS.logoBytes, files: 1, fields: 0 } }))
  uploadLogo(@UploadedFile() file: { buffer: Buffer } | undefined): Promise<UploadedLogo> {
    return this.shop.uploadLogo(file?.buffer);
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'shop-order:ip', limit: 20, windowSeconds: 60 * 60, by: 'ip' })
  place(
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body(new ZodValidationPipe(placeStandOrderSchema)) body: z.output<typeof placeStandOrderSchema>,
  ): Promise<PlaceStandOrderResponse> {
    // @Headers takes no pipes, so the header is validated here.
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey) as string;
    return this.shop.place(idempotencyKey, body);
  }

  @Get('orders/:token')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'shop-track:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  track(@Param('token') token: string): Promise<PublicStandOrder> {
    return this.shop.track(token);
  }

  @Post('orders/:token/pay')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'shop-pay:ip', limit: 30, windowSeconds: 60 * 60, by: 'ip' })
  pay(@Param('token') token: string): Promise<StandOrderCheckout> {
    return this.shop.pay(token);
  }
}

/** The fulfilment queue and the shop's settings, for administrators. */
@Controller('admin')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireRole('ADMIN')
export class AdminShopController {
  constructor(private readonly orders: StandOrdersService) {}

  @Get('stand-orders')
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(standOrdersQuerySchema)) query: z.output<typeof standOrdersQuerySchema>): Promise<Paginated<AdminStandOrder>> {
    return this.orders.list(query);
  }

  @Get('stand-orders/:id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string): Promise<AdminStandOrder> {
    return this.orders.get(id);
  }

  @Patch('stand-orders/:id/status')
  @RateLimit(WRITE_LIMIT)
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateStandOrderStatusSchema)) body: z.output<typeof updateStandOrderStatusSchema>,
    @Req() request: Request,
  ): Promise<AdminStandOrder> {
    return this.orders.updateStatus(auth.userId, id, body, request.ip);
  }

  @Patch('stand-orders/:id')
  @RateLimit(WRITE_LIMIT)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateStandOrderSchema)) body: z.output<typeof updateStandOrderSchema>,
    @Req() request: Request,
  ): Promise<AdminStandOrder> {
    return this.orders.update(auth.userId, id, body, request.ip);
  }

  @Get('stand-orders/:id/lines/:lineId/logo')
  @Header('Cache-Control', 'private, no-store')
  async logo(@Param('id', idParam) id: string, @Param('lineId', idParam) lineId: string): Promise<StreamableFile> {
    return new StreamableFile(await this.orders.logo(id, lineId), { type: 'image/png', disposition: 'inline; filename="logo.png"' });
  }

  @Get('settings/shop')
  @Header('Cache-Control', 'no-store')
  settings(): Promise<ShopSettings> {
    return this.orders.settings();
  }

  @Put('settings/shop')
  @RateLimit(WRITE_LIMIT)
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(shopSettingsSchema)) body: z.output<typeof shopSettingsSchema>,
    @Req() request: Request,
  ): Promise<ShopSettings> {
    return this.orders.updateSettings(auth.userId, body, request.ip);
  }
}
