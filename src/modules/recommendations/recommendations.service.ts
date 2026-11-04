import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createRecommendationSchema,
  normalizeSubdomain,
  type PublicMenuCategory,
  type PublicRecommendation,
  RECOMMENDATION_ERROR_CODES,
  RECOMMENDATION_LIMITS,
  type recommendationEventsSchema,
  type RecommendationFunnel,
  type RecommendationPlacement,
  type RecommendationRule,
  type RecommendationStats,
  type recommendationStatsQuerySchema,
  type updateRecommendationSchema,
} from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';

const ruleInclude = { items: { orderBy: { sortOrder: 'asc' } } } as const;
type RuleRow = Prisma.RecommendationRuleGetPayload<{ include: typeof ruleInclude }>;
const UNBILLED = ['REJECTED', 'CANCELLED'] as const;

const notFound = () => new NotFoundException({ code: RECOMMENDATION_ERROR_CODES.RECOMMENDATION_NOT_FOUND, message: 'Recommendation not found.' });

/**
 * Upselling and cross-selling rules: owners pair a dish with others and choose where diners see
 * them. The public menu carries only the rules (and suggestions) orderable at the branch shown;
 * impressions, clicks and adds come from diners' phones, and purchases are the order lines that
 * carry a rule (checked when the order is placed).
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
  ) {}

  async list(userId: string): Promise<RecommendationRule[]> {
    const restaurantId = await this.restaurantOf(userId);
    const rows = await this.prisma.recommendationRule.findMany({ where: { restaurantId }, orderBy: { sortOrder: 'asc' }, include: ruleInclude });
    return rows.map(toView);
  }

  async create(userId: string, input: z.output<typeof createRecommendationSchema>): Promise<RecommendationRule> {
    const restaurantId = await this.restaurantOf(userId);
    await this.checkItems(restaurantId, input.sourceItemId, input.items, input.type);
    const { _count, _max } = await this.prisma.recommendationRule.aggregate({ where: { restaurantId }, _count: true, _max: { sortOrder: true } });
    if (_count >= RECOMMENDATION_LIMITS.rules) {
      throw new ConflictException({ code: RECOMMENDATION_ERROR_CODES.RECOMMENDATION_LIMIT_REACHED, message: `A restaurant can have at most ${RECOMMENDATION_LIMITS.rules} recommendations.` });
    }
    const row = await this.prisma.recommendationRule.create({
      data: {
        restaurantId, sourceItemId: input.sourceItemId, type: input.type, placements: input.placements, title: input.title ?? null,
        required: input.required ?? false, isActive: input.isActive ?? true, sortOrder: (_max.sortOrder ?? -1) + 1,
        items: { create: input.items.map((item, sortOrder) => ({ ...item, sortOrder })) },
      },
      include: ruleInclude,
    });
    return toView(row);
  }

  async update(userId: string, ruleId: string, input: z.output<typeof updateRecommendationSchema>): Promise<RecommendationRule> {
    const restaurantId = await this.restaurantOf(userId);
    const current = await this.prisma.recommendationRule.findFirst({ where: { id: ruleId, restaurantId }, include: ruleInclude });
    if (!current) throw notFound();
    const type = input.type ?? current.type;
    const placements = input.placements ?? current.placements;
    const required = input.required ?? current.required;
    if (required && !(type === 'ADD_ON' && placements.includes('PRODUCT_DETAILS'))) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Only add-ons shown on the dish page can be required.' });
    }
    const sourceItemId = input.sourceItemId ?? current.sourceItemId;
    const items = input.items ?? current.items.map((item) => ({ itemId: item.itemId, variantId: item.variantId, maxQuantity: item.maxQuantity }));
    if (input.sourceItemId || input.items || input.type) await this.checkItems(restaurantId, sourceItemId, items, type);
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.items) {
        await tx.recommendationRuleItem.deleteMany({ where: { ruleId } });
        await tx.recommendationRuleItem.createMany({ data: input.items.map((item, sortOrder) => ({ ...item, ruleId, sortOrder })) });
      }
      return tx.recommendationRule.update({
        where: { id: ruleId },
        data: {
          sourceItemId, type, placements, required,
          ...(input.title !== undefined && { title: input.title }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
        include: ruleInclude,
      });
    });
    return toView(row);
  }

  /** Past orders keep their lines; they just lose the link to the rule. */
  async remove(userId: string, ruleId: string): Promise<void> {
    const restaurantId = await this.restaurantOf(userId);
    const deleted = await this.prisma.recommendationRule.deleteMany({ where: { id: ruleId, restaurantId } });
    if (deleted.count === 0) throw notFound();
  }

  /**
   * The rules for a branch's public menu: active, with suggestions that are on that menu and
   * orderable (and the fixed size, when one is set, still offered). Alternatives show for a
   * sold-out dish too; the rest need the dish itself to be orderable.
   */
  async publicFor(restaurantId: string, categories: PublicMenuCategory[]): Promise<PublicRecommendation[]> {
    const menu = new Map(categories.flatMap((category) => category.items).map((item) => [item.id, item]));
    if (menu.size === 0) return [];
    const rules = await this.prisma.recommendationRule.findMany({ where: { restaurantId, isActive: true }, orderBy: { sortOrder: 'asc' }, include: ruleInclude });
    return rules.flatMap((rule) => {
      const source = menu.get(rule.sourceItemId);
      if (!source || (!source.isAvailable && rule.type !== 'ALTERNATIVE')) return [];
      const items = rule.items.filter((entry) => {
        const target = menu.get(entry.itemId);
        return target && target.isAvailable && (!entry.variantId || target.variants.some((variant) => variant.id === entry.variantId));
      });
      if (items.length === 0) return [];
      const { isActive: _active, createdAt: _created, ...view } = toView({ ...rule, items });
      return [view];
    });
  }

  /** Diners' impressions, clicks and adds; events for rules of another restaurant are dropped. */
  async recordEvents(rawSubdomain: string, input: z.output<typeof recommendationEventsSchema>): Promise<void> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { subdomain: normalizeSubdomain(rawSubdomain) }, select: { id: true } });
    if (!restaurant) return;
    const branch = await this.prisma.branch.findFirst({
      where: { restaurantId: restaurant.id, isActive: true, ...(input.branch ? { slug: input.branch } : { isMain: true }) }, select: { id: true },
    });
    const ruleIds = await this.prisma.recommendationRule.findMany({
      where: { restaurantId: restaurant.id, id: { in: [...new Set(input.events.map((event) => event.ruleId))] } }, select: { id: true },
    });
    const known = new Set(ruleIds.map((rule) => rule.id));
    const data = input.events.filter((event) => known.has(event.ruleId)).map((event) => ({ ...event, restaurantId: restaurant.id, branchId: branch?.id ?? null }));
    if (data.length) await this.prisma.recommendationEvent.createMany({ data });
  }

  /**
   * The suggestions' attribution on order lines: kept only when the rule is this restaurant's,
   * active, shown at that placement, and suggests that dish (and size). Never refuses the order.
   */
  async attribute<T extends { menuItemId: string; variantId: string; recommendation?: { ruleId: string; placement: RecommendationPlacement } }>(
    restaurantId: string, lines: T[],
  ): Promise<({ recommendationRuleId: string; recommendationPlacement: RecommendationPlacement } | null)[]> {
    const ids = [...new Set(lines.flatMap((line) => (line.recommendation ? [line.recommendation.ruleId] : [])))];
    const rules = ids.length ? await this.prisma.recommendationRule.findMany({ where: { id: { in: ids }, restaurantId, isActive: true }, include: ruleInclude }) : [];
    return lines.map((line) => {
      const rule = line.recommendation && rules.find((candidate) => candidate.id === line.recommendation!.ruleId);
      const fits = rule && rule.placements.includes(line.recommendation!.placement)
        && rule.items.some((entry) => entry.itemId === line.menuItemId && (!entry.variantId || entry.variantId === line.variantId));
      return fits ? { recommendationRuleId: rule.id, recommendationPlacement: line.recommendation!.placement } : null;
    });
  }

  async stats(userId: string, query: z.output<typeof recommendationStatsQuerySchema>, now = new Date()): Promise<RecommendationStats> {
    const scope = await this.scopes.resolve(userId);
    const own = await this.scopes.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 24 * 60 * 60 * 1000);
    const [events, orders] = await Promise.all([
      this.prisma.recommendationEvent.groupBy({
        by: ['ruleId', 'kind'], _count: true,
        where: { restaurantId: own.restaurantId, ...(own.branchId && { branchId: own.branchId }), createdAt: { gte: since } },
      }),
      this.prisma.order.findMany({
        where: { ...own, placedAt: { gte: since }, status: { notIn: [...UNBILLED] } },
        select: { subtotalPiastres: true, items: { select: { recommendationRuleId: true, unitPricePiastres: true, quantity: true } } },
      }),
    ]);
    const byRule = new Map<string, RecommendationFunnel>();
    const funnel = (ruleId: string) => {
      let entry = byRule.get(ruleId);
      if (!entry) byRule.set(ruleId, (entry = { impressions: 0, clicks: 0, adds: 0, purchases: 0, revenuePiastres: 0 }));
      return entry;
    };
    for (const row of events) {
      if (!row.ruleId) continue;
      const entry = funnel(row.ruleId);
      if (row.kind === 'IMPRESSION') entry.impressions += row._count;
      else if (row.kind === 'CLICK') entry.clicks += row._count;
      else entry.adds += row._count;
    }
    const withRecommendation: number[] = [];
    const without: number[] = [];
    for (const order of orders) {
      const suggested = order.items.filter((item) => item.recommendationRuleId);
      (suggested.length ? withRecommendation : without).push(order.subtotalPiastres);
      for (const item of suggested) {
        const entry = funnel(item.recommendationRuleId!);
        entry.purchases += 1;
        entry.revenuePiastres += item.unitPricePiastres * item.quantity;
      }
    }
    const rules = [...byRule.entries()].map(([ruleId, entry]) => ({ ruleId, ...entry, conversionRate: rate(entry.purchases, entry.impressions) }));
    const total = rules.reduce<RecommendationFunnel>((sum, entry) => ({
      impressions: sum.impressions + entry.impressions, clicks: sum.clicks + entry.clicks, adds: sum.adds + entry.adds,
      purchases: sum.purchases + entry.purchases, revenuePiastres: sum.revenuePiastres + entry.revenuePiastres,
    }), { impressions: 0, clicks: 0, adds: 0, purchases: 0, revenuePiastres: 0 });
    return {
      days: query.days, ...total, conversionRate: rate(total.purchases, total.impressions),
      averageOrderPiastres: average([...withRecommendation, ...without]),
      averageOrderWithPiastres: average(withRecommendation),
      averageOrderWithoutPiastres: average(without),
      rules: rules.sort((a, b) => b.revenuePiastres - a.revenuePiastres || b.impressions - a.impressions),
    };
  }

  /**
   * The source and every suggestion are dishes (and sizes) of this restaurant, and none suggests
   * itself, except an upgrade to a fixed size of the same dish (small to large).
   */
  private async checkItems(restaurantId: string, sourceItemId: string, items: { itemId: string; variantId: string | null }[], type: RecommendationRule['type']) {
    const ids = [...new Set([sourceItemId, ...items.map((item) => item.itemId)])];
    const found = await this.prisma.menuItem.findMany({ where: { id: { in: ids }, restaurantId }, select: { id: true, variants: { select: { id: true } } } });
    const byId = new Map(found.map((item) => [item.id, item]));
    const invalid = ids.filter((id) => !byId.has(id));
    for (const item of items) {
      const target = byId.get(item.itemId);
      const suggestsItself = item.itemId === sourceItemId && !(type === 'UPGRADE' && item.variantId);
      if (suggestsItself || (target && item.variantId && !target.variants.some((variant) => variant.id === item.variantId))) invalid.push(item.itemId);
    }
    const keys = items.map((item) => `${item.itemId}:${item.variantId ?? ''}`);
    if (invalid.length || new Set(keys).size !== keys.length) {
      throw new BadRequestException({
        code: RECOMMENDATION_ERROR_CODES.RECOMMENDATION_ITEMS_INVALID,
        message: 'Choose different dishes of your own menu to suggest, each once.',
        details: { menuItemIds: [...new Set(invalid)] },
      });
    }
  }

  private async restaurantOf(userId: string): Promise<string> {
    return (await this.scopes.resolve(userId)).restaurant.id;
  }
}

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);
const average = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

function toView(row: RuleRow): RecommendationRule {
  return {
    id: row.id, sourceItemId: row.sourceItemId, type: row.type, placements: row.placements, title: row.title, required: row.required, isActive: row.isActive,
    items: row.items.map((item) => ({ itemId: item.itemId, variantId: item.variantId, maxQuantity: item.maxQuantity })),
    createdAt: row.createdAt.toISOString(),
  };
}
