import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AdminFaqArticle,
  type AdminFaqCategory,
  type adminFaqQuerySchema,
  type FaqArticle,
  type FaqArticleSummary,
  type FaqCategory,
  type FaqRevision,
  SUPPORT_ERROR_CODES,
  type SupportLanguage,
  type SupportTopic,
  type updateFaqArticleSchema,
  type upsertFaqArticleSchema,
} from '@bilhanah/contracts';
import { Prisma } from '@bilhanah/database';
import type { z } from 'zod';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { search } from './faq-search.js';

export const faqNotFound = () => new NotFoundException({ code: SUPPORT_ERROR_CODES.FAQ_NOT_FOUND, message: 'This question was not found.' });

const articleSelect = {
  id: true, key: true, language: true, question: true, answer: true, keywords: true, relatedKeys: true, sortOrder: true, updatedAt: true,
  category: { select: { slug: true, nameAr: true, nameEn: true } },
} satisfies Prisma.FaqArticleSelect;
type ArticleRow = Prisma.FaqArticleGetPayload<{ select: typeof articleSelect }>;

/** Who is reading, so interactions are kept per restaurant and user. */
export type FaqReader = { userId: string; restaurantId: string | null };

/**
 * The FAQ content: categories and fixed answers, from the database only. Restaurants read published
 * ones; Bilhanah admins edit them, and each edit keeps a revision.
 */
@Injectable()
export class FaqService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Reading (restaurants and the assistant) -------------------------------------------------

  async categories(language: SupportLanguage): Promise<FaqCategory[]> {
    const rows = await this.prisma.faqCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, topic: true, nameAr: true, nameEn: true, icon: true, _count: { select: { articles: { where: { language, status: 'PUBLISHED' } } } } },
    });
    return rows.filter((row) => row._count.articles > 0).map((row) => ({
      id: row.id, slug: row.slug, topic: row.topic as SupportTopic, name: language === 'ar' ? row.nameAr : row.nameEn, icon: row.icon, articleCount: row._count.articles,
    }));
  }

  /** The questions offered when the assistant opens. */
  async suggested(language: SupportLanguage): Promise<FaqArticleSummary[]> {
    const rows = await this.prisma.faqArticle.findMany({
      where: { language, status: 'PUBLISHED', suggested: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      take: 8,
      select: articleSelect,
    });
    return rows.map((row) => this.summary(row));
  }

  async inCategory(language: SupportLanguage, slug: string): Promise<{ name: string; items: FaqArticleSummary[] } | null> {
    const category = await this.prisma.faqCategory.findUnique({ where: { slug }, select: { id: true, nameAr: true, nameEn: true } });
    if (!category) return null;
    const rows = await this.prisma.faqArticle.findMany({
      where: { language, status: 'PUBLISHED', categoryId: category.id },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: articleSelect,
    });
    return { name: language === 'ar' ? category.nameAr : category.nameEn, items: rows.map((row) => this.summary(row)) };
  }

  /** A published answer with its related questions; records the view. */
  async article(id: string, reader: FaqReader | null, sessionId?: string): Promise<FaqArticle> {
    const row = await this.prisma.faqArticle.findFirst({ where: { id, status: 'PUBLISHED' }, select: articleSelect });
    if (!row) throw faqNotFound();
    const related = row.relatedKeys.length
      ? await this.prisma.faqArticle.findMany({ where: { key: { in: row.relatedKeys }, language: row.language, status: 'PUBLISHED' }, select: articleSelect })
      : [];
    if (reader) await this.record({ kind: 'VIEW', articleId: id, reader, sessionId });
    return {
      ...this.summary(row),
      answer: row.answer,
      categoryName: row.language === 'ar' ? row.category.nameAr : row.category.nameEn,
      related: row.relatedKeys.flatMap((key) => related.filter((entry) => entry.key === key).map((entry) => this.summary(entry))),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async search(language: SupportLanguage, query: string, reader: FaqReader | null, categorySlug?: string, sessionId?: string): Promise<FaqArticleSummary[]> {
    const rows = await this.prisma.faqArticle.findMany({
      where: { language, status: 'PUBLISHED', ...(categorySlug && { category: { slug: categorySlug } }) },
      select: articleSelect,
    });
    const found = search(rows, query);
    if (reader && query.trim()) await this.record({ kind: 'SEARCH', reader, query: query.trim().slice(0, 120), resultCount: found.length, sessionId });
    return found.map((row) => this.summary(row));
  }

  /** "Was this helpful?": one answer per user and question; answering again replaces it. */
  async feedback(articleId: string, helpful: boolean, reader: FaqReader, sessionId?: string): Promise<void> {
    const exists = await this.prisma.faqArticle.findFirst({ where: { id: articleId, status: 'PUBLISHED' }, select: { id: true } });
    if (!exists) throw faqNotFound();
    await this.prisma.$transaction([
      this.prisma.faqInteraction.deleteMany({ where: { kind: 'FEEDBACK', articleId, userId: reader.userId } }),
      this.prisma.faqInteraction.create({ data: { kind: 'FEEDBACK', articleId, helpful, userId: reader.userId, restaurantId: reader.restaurantId, sessionId: sessionId ?? null } }),
    ]);
  }

  private record(input: { kind: 'VIEW' | 'SEARCH'; reader: FaqReader; articleId?: string; query?: string; resultCount?: number; sessionId?: string }) {
    return this.prisma.faqInteraction.create({
      data: {
        kind: input.kind, articleId: input.articleId ?? null, userId: input.reader.userId, restaurantId: input.reader.restaurantId,
        query: input.query ?? null, resultCount: input.resultCount ?? null, sessionId: input.sessionId ?? null,
      },
    });
  }

  private summary(row: ArticleRow): FaqArticleSummary {
    return { id: row.id, key: row.key, question: row.question, categorySlug: row.category.slug };
  }

  // --- Management (Bilhanah admins) ---------------------------------------------------------------

  async adminCategories(): Promise<AdminFaqCategory[]> {
    const rows = await this.prisma.faqCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }] });
    return rows.map((row) => ({ id: row.id, slug: row.slug, topic: row.topic as SupportTopic, nameAr: row.nameAr, nameEn: row.nameEn, icon: row.icon, sortOrder: row.sortOrder }));
  }

  async adminArticles(query: z.output<typeof adminFaqQuerySchema>): Promise<AdminFaqArticle[]> {
    const rows = await this.prisma.faqArticle.findMany({
      where: {
        ...(query.lang && { language: query.lang }),
        ...(query.status && { status: query.status }),
        ...(query.category && { categoryId: query.category }),
        ...(query.q && { OR: [{ question: { contains: query.q, mode: 'insensitive' } }, { key: { contains: query.q, mode: 'insensitive' } }] }),
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { key: 'asc' }, { language: 'asc' }],
    });
    const stats = await this.stats(rows.map((row) => row.id));
    return rows.map((row) => this.toAdmin(row, stats.get(row.id)));
  }

  async create(editorId: string, input: z.output<typeof upsertFaqArticleSchema>): Promise<AdminFaqArticle> {
    await this.assertCategory(input.categoryId);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const article = await tx.faqArticle.create({ data: { ...input } });
        await tx.faqRevision.create({ data: { articleId: article.id, version: 1, question: article.question, answer: article.answer, keywords: article.keywords, status: article.status, editorId } });
        return article;
      });
      return this.toAdmin(row);
    } catch (error) {
      throw this.keyTaken(error);
    }
  }

  /** Saves a new version; the previous text stays in the revisions. */
  async update(editorId: string, id: string, input: z.output<typeof updateFaqArticleSchema>): Promise<AdminFaqArticle> {
    if (input.categoryId) await this.assertCategory(input.categoryId);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.faqArticle.findUnique({ where: { id } });
        if (!current) throw faqNotFound();
        const article = await tx.faqArticle.update({ where: { id }, data: { ...input, version: current.version + 1 } });
        await tx.faqRevision.create({
          data: { articleId: id, version: article.version, question: article.question, answer: article.answer, keywords: article.keywords, status: article.status, editorId },
        });
        return article;
      });
      const stats = await this.stats([id]);
      return this.toAdmin(row, stats.get(id));
    } catch (error) {
      throw this.keyTaken(error);
    }
  }

  async revisions(id: string): Promise<FaqRevision[]> {
    const exists = await this.prisma.faqArticle.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw faqNotFound();
    const rows = await this.prisma.faqRevision.findMany({ where: { articleId: id }, orderBy: { version: 'desc' }, include: { editor: { select: { fullName: true } } } });
    return rows.map((row) => ({ version: row.version, question: row.question, answer: row.answer, status: row.status, editorName: row.editor?.fullName ?? null, createdAt: row.createdAt.toISOString() }));
  }

  private async assertCategory(id: string) {
    const category = await this.prisma.faqCategory.findUnique({ where: { id }, select: { id: true } });
    if (!category) throw new NotFoundException({ code: SUPPORT_ERROR_CODES.FAQ_CATEGORY_NOT_FOUND, message: 'Category not found.' });
  }

  private keyTaken(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException({ code: SUPPORT_ERROR_CODES.FAQ_KEY_TAKEN, message: 'This key already has a question in this language.' });
    }
    return error;
  }

  private async stats(ids: string[]) {
    const map = new Map<string, { views: number; helpful: number; notHelpful: number }>();
    if (!ids.length) return map;
    const rows = await this.prisma.faqInteraction.groupBy({ by: ['articleId', 'kind', 'helpful'], where: { articleId: { in: ids }, kind: { in: ['VIEW', 'FEEDBACK'] } }, _count: { _all: true } });
    for (const row of rows) {
      if (!row.articleId) continue;
      const entry = map.get(row.articleId) ?? { views: 0, helpful: 0, notHelpful: 0 };
      if (row.kind === 'VIEW') entry.views += row._count._all;
      else if (row.helpful) entry.helpful += row._count._all;
      else entry.notHelpful += row._count._all;
      map.set(row.articleId, entry);
    }
    return map;
  }

  private toAdmin(row: Prisma.FaqArticleGetPayload<object>, stats = { views: 0, helpful: 0, notHelpful: 0 }): AdminFaqArticle {
    return {
      id: row.id, key: row.key, language: row.language, categoryId: row.categoryId, question: row.question, answer: row.answer, keywords: row.keywords,
      relatedKeys: row.relatedKeys, suggested: row.suggested, sortOrder: row.sortOrder, status: row.status, version: row.version, ...stats,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }
}
