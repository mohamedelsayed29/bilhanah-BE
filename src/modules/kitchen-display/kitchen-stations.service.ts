import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createKitchenStationSchema,
  KITCHEN_DISPLAY_ERROR_CODES,
  KITCHEN_STATION_LIMITS,
  type KitchenReadyRule,
  type KitchenStation,
  type KitchenStationKind,
  type KitchenStationList,
  type KitchenStats,
  type kitchenStatsQuerySchema,
  type updateKitchenStationSchema,
} from '@bilhanah/contracts';
import { Prisma, type KitchenStation as StationRow } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';

type Tx = Prisma.TransactionClient;

/** Every restaurant starts with these; the first is the default (dishes without a station go there). */
const DEFAULT_STATIONS: { kind: KitchenStationKind; nameAr: string; nameEn: string; targetMinutes: number }[] = [
  { kind: 'MAIN', nameAr: 'المطبخ الرئيسي', nameEn: 'Main kitchen', targetMinutes: 15 },
  { kind: 'GRILL', nameAr: 'الشوي', nameEn: 'Grill', targetMinutes: 20 },
  { kind: 'DRINKS', nameAr: 'المشروبات', nameEn: 'Drinks', targetMinutes: 5 },
  { kind: 'DESSERTS', nameAr: 'الحلويات', nameEn: 'Desserts', targetMinutes: 10 },
];

const stationNotFound = () => new NotFoundException({ code: KITCHEN_DISPLAY_ERROR_CODES.STATION_NOT_FOUND, message: 'Kitchen station not found.' });
const defaultLocked = () =>
  new ConflictException({ code: KITCHEN_DISPLAY_ERROR_CODES.DEFAULT_STATION_LOCKED, message: 'Make another station the default first.' });

export const toStation = (row: StationRow): KitchenStation => ({
  id: row.id,
  nameAr: row.nameAr,
  nameEn: row.nameEn,
  kind: row.kind,
  targetMinutes: row.targetMinutes,
  isDefault: row.isDefault,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
});

/** Where a dish is prepared: its own station, else its category's, else the default; switched-off stations fall back to the default. */
export type StationRouter = (item: { stationId: string | null; category: { stationId: string | null } }) => { id: string; name: string } | null;

/**
 * Preparation stations of a restaurant (main kitchen, grill, drinks, desserts...) and its kitchen
 * display settings. Stations are shared by every branch; each kitchen screen picks the one it shows.
 */
@Injectable()
export class KitchenStationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
  ) {}

  /** Any restaurant account: kitchen screens need the stations to filter by. */
  async list(userId: string): Promise<KitchenStationList> {
    const scope = await this.scopes.resolve(userId);
    const [stations, restaurant] = await Promise.all([
      this.ensure(scope.restaurant.id),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: scope.restaurant.id }, select: { kitchenReadyRule: true } }),
    ]);
    return { stations: stations.map(toStation), readyRule: restaurant.kitchenReadyRule };
  }

  async create(userId: string, input: z.output<typeof createKitchenStationSchema>): Promise<KitchenStation> {
    const restaurantId = await this.managedRestaurant(userId);
    const stations = await this.ensure(restaurantId);
    if (stations.length >= KITCHEN_STATION_LIMITS.stations) {
      throw new ConflictException({ code: KITCHEN_DISPLAY_ERROR_CODES.STATION_LIMIT_REACHED, message: `Up to ${KITCHEN_STATION_LIMITS.stations} stations.` });
    }
    const row = await this.prisma.kitchenStation.create({
      data: { ...input, nameEn: input.nameEn ?? null, restaurantId, sortOrder: Math.max(-1, ...stations.map((station) => station.sortOrder)) + 1 },
    });
    return toStation(row);
  }

  async update(userId: string, id: string, input: z.output<typeof updateKitchenStationSchema>): Promise<KitchenStationList> {
    const restaurantId = await this.managedRestaurant(userId);
    await this.prisma.$transaction(async (tx) => {
      const station = await tx.kitchenStation.findFirst({ where: { id, restaurantId } });
      if (!station) throw stationNotFound();
      if (station.isDefault && input.isActive === false) throw defaultLocked();
      if (input.isDefault) {
        await tx.kitchenStation.updateMany({ where: { restaurantId, isDefault: true }, data: { isDefault: false } });
      }
      const { isDefault, ...fields } = input;
      await tx.kitchenStation.update({
        where: { id },
        data: { ...fields, ...(isDefault && { isDefault: true, isActive: true }) },
      });
    });
    return this.list(userId);
  }

  /** Dishes and categories that used it go to the default station. */
  async remove(userId: string, id: string): Promise<void> {
    const restaurantId = await this.managedRestaurant(userId);
    const station = await this.prisma.kitchenStation.findFirst({ where: { id, restaurantId } });
    if (!station) throw stationNotFound();
    if (station.isDefault) throw defaultLocked();
    await this.prisma.kitchenStation.delete({ where: { id } });
  }

  async setReadyRule(userId: string, readyRule: KitchenReadyRule): Promise<KitchenStationList> {
    const restaurantId = await this.managedRestaurant(userId);
    await this.prisma.restaurant.update({ where: { id: restaurantId }, data: { kitchenReadyRule: readyRule } });
    return this.list(userId);
  }

  /** The station routing for a new order (creates the default stations the first time). */
  async router(restaurantId: string): Promise<StationRouter> {
    const stations = await this.ensure(restaurantId);
    const byId = new Map(stations.filter((station) => station.isActive).map((station) => [station.id, station]));
    const fallback = stations.find((station) => station.isDefault) ?? null;
    return (item) => {
      const station = byId.get(item.stationId ?? '') ?? byId.get(item.category.stationId ?? '') ?? fallback;
      return station ? { id: station.id, name: station.nameAr } : null;
    };
  }

  /** The kitchen's speed and accuracy over the period (see KitchenStats). */
  async stats(userId: string, query: z.output<typeof kitchenStatsQuerySchema>, now = new Date()): Promise<KitchenStats> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope, query.branchId);
    const since = new Date(now.getTime() - query.days * 86_400_000);
    const branch = where.branchId ? Prisma.sql`AND o.branch_id = ${where.branchId}::uuid` : Prisma.empty;
    const done = Prisma.sql`o.restaurant_id = ${where.restaurantId}::uuid ${branch} AND o.placed_at >= ${since}
      AND o.ready_at IS NOT NULL AND o.status NOT IN ('REJECTED', 'CANCELLED')`;
    // An order's target: its estimate, else its slowest station's usual time.
    const target = Prisma.sql`COALESCE(o.estimated_ready_at, o.placed_at + make_interval(mins => COALESCE((
      SELECT MAX(s.target_minutes) FROM order_items i JOIN kitchen_stations s ON s.id = i.station_id WHERE i.order_id = o.id), 15)))`;
    const [row] = await this.prisma.$queryRaw<{ orders: bigint; prep: number | null; total: number | null; delayed: bigint; accurate: bigint }[]>`
      SELECT COUNT(*) AS orders,
        AVG(EXTRACT(EPOCH FROM (o.ready_at - COALESCE(o.accepted_at, o.placed_at))) / 60)::float AS prep,
        AVG(EXTRACT(EPOCH FROM (o.ready_at - o.placed_at)) / 60)::float AS total,
        COUNT(*) FILTER (WHERE o.ready_at > ${target}) AS delayed,
        COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.prep_status = 'CANCELLED')
          AND NOT EXISTS (SELECT 1 FROM order_item_events e WHERE e.order_id = o.id AND e.status = 'READY' GROUP BY e.order_item_id HAVING COUNT(*) > 1)) AS accurate
      FROM orders o WHERE ${done}`;
    const stationRows = await this.prisma.$queryRaw<{ id: string | null; name: string | null; items: bigint; prep: number | null; delayed: bigint }[]>`
      SELECT i.station_id AS id, COALESCE(s.name_ar, MAX(i.station_name)) AS name, COUNT(*) AS items,
        AVG(EXTRACT(EPOCH FROM (i.ready_at - COALESCE(i.started_at, i.accepted_at, o.accepted_at, o.placed_at))) / 60)::float AS prep,
        COUNT(*) FILTER (WHERE i.ready_at > o.placed_at + make_interval(mins => COALESCE(s.target_minutes, 15))) AS delayed
      FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN kitchen_stations s ON s.id = i.station_id
      WHERE ${done} AND i.ready_at IS NOT NULL
      GROUP BY i.station_id, s.name_ar, s.sort_order ORDER BY s.sort_order NULLS LAST`;
    const orders = Number(row?.orders ?? 0);
    const delayed = Number(row?.delayed ?? 0);
    const accurate = Number(row?.accurate ?? 0);
    const round = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
    return {
      days: query.days,
      orders,
      averagePrepMinutes: round(row?.prep),
      averagePlacedToReadyMinutes: round(row?.total),
      delayed,
      delayRate: orders ? delayed / orders : null,
      accurate,
      accuracyRate: orders ? accurate / orders : null,
      stations: stationRows.map((station) => ({
        id: station.id,
        name: station.name ?? '—',
        items: Number(station.items),
        averagePrepMinutes: round(station.prep),
        delayed: Number(station.delayed),
      })),
    };
  }

  /** The restaurant's stations in order, creating the defaults the first time (once, even when called concurrently). */
  async ensure(restaurantId: string, client: PrismaService | Tx = this.prisma): Promise<StationRow[]> {
    const order = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];
    const existing = await client.kitchenStation.findMany({ where: { restaurantId }, orderBy: order });
    if (existing.length) return existing;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kitchen-stations:${restaurantId}`}))`;
      const again = await tx.kitchenStation.findMany({ where: { restaurantId }, orderBy: order });
      if (again.length) return again;
      await tx.kitchenStation.createMany({
        data: DEFAULT_STATIONS.map((station, index) => ({ ...station, restaurantId, sortOrder: index, isDefault: index === 0 })),
      });
      return tx.kitchenStation.findMany({ where: { restaurantId }, orderBy: order });
    });
  }

  private async managedRestaurant(userId: string): Promise<string> {
    const scope = await this.scopes.resolve(userId);
    this.scopes.require(scope, 'settings.manage');
    return scope.restaurant.id;
  }
}
