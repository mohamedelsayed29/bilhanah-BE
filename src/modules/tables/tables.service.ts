import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

const tableNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'Table not found.' });
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
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
    const current = await this.prisma.table.findFirst({ where: { id: tableId, ...where }, select: { branchId: true, areaId: true } });
    if (!current) throw tableNotFound();
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
    return this.toView(await this.prisma.table.findUniqueOrThrow({ where: { id: tableId } }), restaurant.subdomain);
  }

  /** Past orders keep the table's name. */
  async remove(userId: string, tableId: string): Promise<void> {
    const { where } = await this.own(userId);
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

  /** The table a diner scanned, so the menu can show "Table 5" and open its branch. */
  async findPublic(rawSubdomain: string, code: string): Promise<PublicTable> {
    const table = await this.prisma.table.findFirst({
      where: { publicCode: code, isActive: true, branch: { isActive: true }, restaurant: { subdomain: normalizeSubdomain(rawSubdomain) } },
      select: { label: true, branch: { select: { slug: true } } },
    });
    if (!table) throw tableNotFound();
    return { label: table.label, branch: table.branch.slug };
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
