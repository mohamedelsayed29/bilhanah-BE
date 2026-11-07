import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  type LoyaltyAnalytics,
  loyaltyAdjustSchema,
  loyaltyAnalyticsQuerySchema,
  type LoyaltyCardLink,
  loyaltyJoinSchema,
  type LoyaltyJoinResponse,
  type LoyaltyMemberDetail,
  type LoyaltyMembersPage,
  loyaltyMembersQuerySchema,
  type LoyaltyMemberView,
  loyaltyMeSchema,
  type LoyaltyReward,
  loyaltyRewardSchema,
  type LoyaltySettings,
  loyaltySettingsSchema,
  type LoyaltyTier,
  loyaltyTiersSchema,
  type PublicLoyaltyProgram,
} from '@bilhanah/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../../common/decorators/current-auth.decorator.js';
import { AccessTokenGuard } from '../../common/guards/access-token.guard.js';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { RequireAnyPermission, RequirePermission, RolesGuard } from '../../common/guards/roles.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { LoyaltyService } from './loyalty.service.js';

const idParam = new ZodValidationPipe(z.uuid());
const WRITE_LIMIT = { name: 'loyalty-write:ip', limit: 120, windowSeconds: 60, by: 'ip' } as const;

/**
 * The restaurant's loyalty program (docs/LOYALTY.md): loyalty.view reads members and analytics,
 * loyalty.adjust changes points and issues cards, loyalty.settings runs the program. 409
 * LOYALTY_UNAVAILABLE while the service is off or the plan has no ordering.
 */
@Controller('loyalty')
@UseGuards(AccessTokenGuard, RolesGuard, RateLimitGuard)
@RequireAnyPermission('loyalty.view', 'loyalty.settings')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(@CurrentAuth() auth: AuthContext): Promise<LoyaltySettings> {
    return this.loyalty.getSettings(auth.userId);
  }

  @Put('settings')
  @RequirePermission('loyalty.settings')
  @RateLimit(WRITE_LIMIT)
  saveSettings(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(loyaltySettingsSchema)) body: z.output<typeof loyaltySettingsSchema>): Promise<LoyaltySettings> {
    return this.loyalty.saveSettings(auth.userId, body);
  }

  @Get('tiers')
  @Header('Cache-Control', 'no-store')
  tiers(@CurrentAuth() auth: AuthContext): Promise<LoyaltyTier[]> {
    return this.loyalty.tiers(auth.userId);
  }

  @Put('tiers')
  @RequirePermission('loyalty.settings')
  @RateLimit(WRITE_LIMIT)
  saveTiers(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(loyaltyTiersSchema)) body: z.output<typeof loyaltyTiersSchema>): Promise<LoyaltyTier[]> {
    return this.loyalty.saveTiers(auth.userId, body);
  }

  @Get('rewards')
  @Header('Cache-Control', 'no-store')
  rewards(@CurrentAuth() auth: AuthContext): Promise<LoyaltyReward[]> {
    return this.loyalty.rewards(auth.userId);
  }

  @Post('rewards')
  @RequirePermission('loyalty.settings')
  @RateLimit(WRITE_LIMIT)
  createReward(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(loyaltyRewardSchema)) body: z.output<typeof loyaltyRewardSchema>): Promise<LoyaltyReward> {
    return this.loyalty.createReward(auth.userId, body);
  }

  @Put('rewards/:id')
  @RequirePermission('loyalty.settings')
  @RateLimit(WRITE_LIMIT)
  updateReward(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(loyaltyRewardSchema)) body: z.output<typeof loyaltyRewardSchema>): Promise<LoyaltyReward> {
    return this.loyalty.updateReward(auth.userId, id, body);
  }

  @Delete('rewards/:id')
  @RequirePermission('loyalty.settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  deleteReward(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.loyalty.deleteReward(auth.userId, id);
  }

  @Get('members')
  @RequirePermission('loyalty.view')
  @Header('Cache-Control', 'no-store')
  members(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(loyaltyMembersQuerySchema)) query: z.output<typeof loyaltyMembersQuerySchema>): Promise<LoyaltyMembersPage> {
    return this.loyalty.members(auth.userId, query);
  }

  @Get('members/:id')
  @RequirePermission('loyalty.view')
  @Header('Cache-Control', 'no-store')
  member(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<LoyaltyMemberDetail> {
    return this.loyalty.member(auth.userId, id);
  }

  @Post('members/:id/adjustments')
  @RequirePermission('loyalty.adjust')
  @RateLimit(WRITE_LIMIT)
  adjust(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(loyaltyAdjustSchema)) body: z.output<typeof loyaltyAdjustSchema>): Promise<LoyaltyMemberDetail> {
    return this.loyalty.adjust(auth.userId, id, body);
  }

  @Post('members/:id/card')
  @RequirePermission('loyalty.adjust')
  @Header('Cache-Control', 'no-store')
  @RateLimit(WRITE_LIMIT)
  card(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<LoyaltyCardLink> {
    return this.loyalty.issueCard(auth.userId, id);
  }

  @Get('analytics')
  @RequirePermission('loyalty.view')
  @Header('Cache-Control', 'no-store')
  analytics(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(loyaltyAnalyticsQuerySchema)) query: z.output<typeof loyaltyAnalyticsQuerySchema>): Promise<LoyaltyAnalytics> {
    return this.loyalty.analytics(auth.userId, query);
  }
}

/** Diners: the program, their card's page (the card goes in the body, never the URL), and joining. */
@Controller('public/restaurants/:subdomain/loyalty')
@UseGuards(RateLimitGuard)
export class PublicLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'loyalty-program:ip', limit: 300, windowSeconds: 60, by: 'ip' })
  program(@Param('subdomain') subdomain: string): Promise<PublicLoyaltyProgram> {
    return this.loyalty.publicProgram(subdomain);
  }

  @Post('me')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RateLimit({ name: 'loyalty-me:ip', limit: 120, windowSeconds: 60, by: 'ip' })
  me(@Param('subdomain') subdomain: string, @Body(new ZodValidationPipe(loyaltyMeSchema)) body: z.output<typeof loyaltyMeSchema>): Promise<LoyaltyMemberView> {
    return this.loyalty.me(subdomain, body.pass);
  }

  @Post('join')
  @Header('Cache-Control', 'no-store')
  // Joining reveals whether a phone is a member: kept slow.
  @RateLimit({ name: 'loyalty-join:ip', limit: 10, windowSeconds: 10 * 60, by: 'ip' })
  join(@Param('subdomain') subdomain: string, @Body(new ZodValidationPipe(loyaltyJoinSchema)) body: z.output<typeof loyaltyJoinSchema>): Promise<LoyaltyJoinResponse> {
    return this.loyalty.join(subdomain, body);
  }
}
