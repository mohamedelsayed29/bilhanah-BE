import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import {
  type bulkCreateTablesSchema,
  type createTableSchema,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  ORDER_LIMITS,
  type PublicTable,
  type RestaurantTable,
  type updateTableSchema,
} from '@bilhanah/contracts';
import type { Table } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';
import { tableAreaNotFound } from './table-areas.service.js';
import { REDIS } from '../../infrastructure/redis/redis.module.js';
import { businessDay } from '../orders/business-day.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/** A phone opening the same table's menu again within this window is the same scan. */
const SCAN_WINDOW_SECONDS = 30 * 60;
import { openOrdersOnTableWhere, seatedWhere } from './occupancy.js';

const tableNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'Table not found.' });
const inGroup = () => new ConflictException({ code: ORDER_ERROR_CODES.TABLE_IN_GROUP, message: 'This table is merged with others: separate them first.' });
const labelTaken = () =>
  new ConflictException({ code: ORDER_ERROR_CODES.TABLE_LABEL_TAKEN, message: 'Another table already has this name.' });

/** 64 random bits, URL-safe; printed in the table's QR code. */
const newPublicCode = () => randomBytes(8).toString('base64url');

/**
 * Dining tables and their QR codes. Each table belongs to one branch; owners
 * manage every branch's tables, managers their own branch's.
 */
@Injectable()
export class TablesService {
  private readonly urlTemplate: string;

  private readonly scanSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    private readonly realtime: RealtimeService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
    this.scanSecret = config.get('DATA_ENCRYPTION_KEY', { infer: true }) ?? config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  /** One branch's tables, or every table the caller may see when no branch is given. */
  async list(userId: string, branchId?: string): Promise<RestaurantTable[]> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope, branchId);
    const tables = await this.prisma.table.findMany({ where, orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }] });
    return tables.map((table) => this.toView(table, scope.restaurant.subdomain));
  }

  async create(userId: string, input: z.output<typeof createTableSchema>): Promise<RestaurantTable> {
    const { restaurant, branch } = await this.target(userId, input.branchId);
    const { branchId: _branch, areaId, ...fields } = input;
    Object.assign(fields, await this.placement(branch.id, areaId));
    const { _count, _max } = await this.prisma.table.aggregate({ where: { branchId: branch.id }, _count: true, _max: { sortOrder: true } });
    if (_count >= ORDER_LIMITS.tables) throw this.limitReached();
    try {
      const table = await this.prisma.table.create({
        data: { restaurantId: restaurant.id, branchId: branch.id, ...fields, publicCode: newPublicCode(), sortOrder: (_max.sortOrder ?? -1) + 1 },
      });
      return this.toView(table, restaurant.subdomain);
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
  }

  /** Creates {prefix}{from} ... {prefix}{to}, all of one shape, size and location; labels that already exist are skipped. */
  async createRange(userId: string, input: z.output<typeof bulkCreateTablesSchema>): Promise<RestaurantTable[]> {
    const { restaurant, branch } = await this.target(userId, input.branchId);
    const existing = await this.prisma.table.findMany({ where: { branchId: branch.id }, select: { label: true, sortOrder: true } });
    const taken = new Set(existing.map((table) => table.label));
    // "Table" + 5 → "Table 5" and "طاولة" + 5 → "طاولة 5"; "T-" + 5 → "T-5".
    const separator = /[\p{L}\p{N}]$/u.test(input.prefix) ? ' ' : '';
    const labels = Array.from({ length: input.to - input.from + 1 }, (_, index) => `${input.prefix}${separator}${input.from + index}`).filter(
      (label) => !taken.has(label),
    );
    if (existing.length + labels.length > ORDER_LIMITS.tables) throw this.limitReached();
    const start = Math.max(-1, ...existing.map((table) => table.sortOrder)) + 1;
    const placement = { location: input.location, ...(await this.placement(branch.id, input.areaId)) };
    await this.prisma.table.createMany({
      data: labels.map((label, index) => ({
        restaurantId: restaurant.id,
        branchId: branch.id,
        label,
        shape: input.shape,
        seats: input.seats,
        ...placement,
        publicCode: newPublicCode(),
        sortOrder: start + index,
      })),
      skipDuplicates: true,
    });
    return this.list(userId, branch.id);
  }

  async update(userId: string, tableId: string, input: z.output<typeof updateTableSchema>): Promise<RestaurantTable> {
    const { restaurant, where } = await this.own(userId);
    const current = await this.prisma.table.findFirst({ where: { id: tableId, ...where }, select: { branchId: true, areaId: true, label: true, isActive: true, groupId: true } });
    if (!current) throw tableNotFound();
    // A merged table moves with its group: no switching it off or moving it to another area on its own.
    if (current.groupId && (input.isActive === false || (input.areaId !== undefined && input.areaId !== current.areaId))) throw inGroup();
    // Switching a table off while guests are at it would hide their bill: settle it first.
    if (input.isActive === false && current.isActive) {
      const now = new Date();
      const [orders, seated] = await Promise.all([
        this.prisma.order.count({ where: openOrdersOnTableWhere({ id: tableId, label: current.label, branchId: current.branchId }, now) }),
        this.prisma.reservation.count({ where: { ...seatedWhere(current.branchId, now), tableId } }),
      ]);
      if (orders + seated > 0) {
        throw new ConflictException({ code: ORDER_ERROR_CODES.TABLE_STATUS_INVALID, message: 'Guests are at this table: settle its bill first.', details: { from: 'OCCUPIED', to: 'UNAVAILABLE' } });
      }
    }
    // A table in an area stands where the area does: moving it moves its location, and its own
    // location only changes while it is in no area.
    const { areaId, ...fields } = input;
    const data = { ...fields, ...(await this.placement(current.branchId, areaId === undefined ? current.areaId : areaId)), ...(areaId !== undefined && { areaId }) };
    try {
      const updated = await this.prisma.table.updateMany({ where: { id: tableId, ...where }, data });
      if (updated.count === 0) throw tableNotFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
    const saved = await this.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    if (input.isActive !== undefined && input.isActive !== current.isActive) {
      this.realtime.emitTableUpdated(restaurant.id, { branchId: saved.branchId, tableId, status: saved.isActive ? (saved.condition === 'CLEANING' ? 'CLEANING' : 'AVAILABLE') : 'UNAVAILABLE' });
    }
    return this.toView(saved, restaurant.subdomain);
  }

  /** Past orders keep the table's name. */
  async remove(userId: string, tableId: string): Promise<void> {
    const { where } = await this.own(userId);
    if (await this.prisma.table.count({ where: { id: tableId, ...where, groupId: { not: null } } })) throw inGroup();
    const deleted = await this.prisma.table.deleteMany({ where: { id: tableId, ...where } });
    if (deleted.count === 0) throw tableNotFound();
  }

  /** A new QR code for the table; codes already printed stop working. */
  async regenerateCode(userId: string, tableId: string): Promise<RestaurantTable> {
    const { restaurant, where } = await this.own(userId);
    const updated = await this.prisma.table.updateMany({ where: { id: tableId, ...where }, data: { publicCode: newPublicCode() } });
    if (updated.count === 0) throw tableNotFound();
    return this.toView(await this.prisma.table.findUniqueOrThrow({ where: { id: tableId } }), restaurant.subdomain);
  }

  /** The table a diner scanned, so the menu can show "Table 5" and open its branch. Counts the scan (see recordScan). */
  async findPublic(rawSubdomain: string, code: string, visitor?: { ip: string; userAgent: string }, now = new Date()): Promise<PublicTable> {
    const table = await this.prisma.table.findFirst({
      where: { publicCode: code, isActive: true, branch: { isActive: true }, restaurant: { subdomain: normalizeSubdomain(rawSubdomain) } },
      select: { id: true, label: true, restaurantId: true, branchId: true, restaurant: { select: { timezone: true } }, branch: { select: { slug: true } } },
    });
    if (!table) throw tableNotFound();
    // Counting never gets in the diner's way.
    if (visitor) await this.recordScan(table, visitor, now).catch(() => undefined);
    return { label: table.label, branch: table.branch.slug };
  }

  /**
   * One QR scan of a table for its local day. A phone counts once per SCAN_WINDOW_SECONDS (a refresh is not a
   * new scan); it is recognised by a hash of its address and browser, salted per day, so neither is stored.
   */
  private async recordScan(table: { id: string; restaurantId: string; branchId: string; restaurant: { timezone: string } }, visitor: { ip: string; userAgent: string }, now: Date) {
    const day = businessDay(now, table.restaurant.timezone);
    const salt = createHmac('sha256', this.scanSecret).update(`table-scans:${day.toISOString().slice(0, 10)}`).digest();
    const phone = createHash('sha256').update(salt).update(`${visitor.ip}\n${visitor.userAgent}`).digest('base64url').slice(0, 22);
    if ((await this.redis.set(`table-scan:${table.id}:${phone}`, '1', 'EX', SCAN_WINDOW_SECONDS, 'NX')) !== 'OK') return;
    await this.prisma.tableDailyStat.upsert({
      where: { tableId_day: { tableId: table.id, day } },
      create: { tableId: table.id, restaurantId: table.restaurantId, branchId: table.branchId, day, scans: 1 },
      update: { scans: { increment: 1 } },
    });
  }

  private toView(table: Table, subdomain: string): RestaurantTable {
    return {
      id: table.id,
      branchId: table.branchId,
      label: table.label,
      shape: table.shape,
      seats: table.seats,
      location: table.location,
      areaId: table.areaId,
      floorX: table.floorX,
      floorY: table.floorY,
      floorRotation: table.floorRotation,
      floorScale: table.floorScale,
      minOrderPiastres: table.minOrderPiastres,
      notes: table.notes,
      attributes: table.attributes,
      publicCode: table.publicCode,
      cleaning: table.condition === 'CLEANING',
      groupId: table.groupId,
      isActive: table.isActive,
      qrUrl: `${this.urlTemplate.replace('{subdomain}', subdomain)}/?t=${table.publicCode}`,
      createdAt: table.createdAt.toISOString(),
    };
  }

  private limitReached() {
    return new ConflictException({
      code: ORDER_ERROR_CODES.TABLE_LIMIT_REACHED,
      message: `A branch can have at most ${ORDER_LIMITS.tables} tables.`,
      details: { limit: ORDER_LIMITS.tables },
    });
  }

  /** A table's area, checked to be of its branch; a table in an area takes the area's location. */
  private async placement(branchId: string, areaId: string | null | undefined): Promise<{ areaId?: string | null; location?: Table['location'] }> {
    if (!areaId) return areaId === null ? { areaId: null } : {};
    const area = await this.prisma.tableArea.findFirst({ where: { id: areaId, branchId }, select: { id: true, location: true } });
    if (!area) throw tableAreaNotFound();
    return { areaId: area.id, location: area.location };
  }

  /** The branch new tables go to: the requested one (checked), the manager's, or the main branch. */
  private async target(userId: string, branchId?: string) {
    const scope = await this.scopes.resolve(userId);
    return { restaurant: scope.restaurant, branch: await this.scopes.branch(scope, branchId) };
  }

  /** Tables the caller may change. */
  private async own(userId: string) {
    const scope = await this.scopes.resolve(userId);
    return { restaurant: scope.restaurant, where: await this.scopes.branchWhere(scope) };
  }
}
