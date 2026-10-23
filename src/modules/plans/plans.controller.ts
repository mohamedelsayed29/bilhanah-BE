import { Controller, Get, Header } from '@nestjs/common';
import { PLAN_FEATURES, type PublicPlan } from '@bilhanah/contracts';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

/** Plan prices for the website's pricing section. */
@Controller('public/plans')
export class PlansController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async list(): Promise<PublicPlan[]> {
    const plans = await this.prisma.plan.findMany({ orderBy: { priceMonthlyPiastres: 'asc' } });
    return plans.map((plan) => ({
      code: plan.code,
      priceMonthlyPiastres: plan.priceMonthlyPiastres,
      features: PLAN_FEATURES[plan.code],
    }));
  }
}
