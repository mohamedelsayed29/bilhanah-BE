import { Injectable } from '@nestjs/common';
import type { AssistantBlock, AssistantInput, SupportLanguage } from '@bilhanah/contracts';
import { FaqService } from '../faq/faq.service.js';
import type { AssistantContext, AssistantProvider, AssistantReply } from './assistant-provider.js';

const COPY = {
  welcome: ['أهلًا بيك في دعم بالهنا! نقدر نساعدك إزاي النهارده؟', 'Hi! Welcome to Bilhanah Support. How can we help you today?'],
  abilities: [
    'اختار سؤال من تحت، أو اكتب سؤالك. ولو محتاج حد من فريقنا، كلّمنا في أي وقت.',
    'Pick a question below or type your own. If you need someone from our team, contact us any time.',
  ],
  suggested: ['أسئلة شائعة', 'Frequently asked'],
  home: ['تحب تسأل عن إيه؟', 'What would you like to ask about?'],
  results: ['دي أقرب إجابات لسؤالك:', 'These answers are the closest to your question:'],
  noResults: ['ملقيتش إجابة لسؤالك ده. جرّب كلام تاني، أو كلّم فريق الدعم وهيردوا عليك.', 'I could not find an answer to that. Try other words, or contact our support team and they will get back to you.'],
  emptyCategory: ['مفيش أسئلة في القسم ده لسه.', 'There are no questions in this topic yet.'],
  unknownCategory: ['القسم ده مش موجود.', 'That topic does not exist.'],
  thanks: ['تمام، مبسوطين إنها ساعدتك!', 'Great, glad it helped!'],
  sorry: ['آسفين إن الإجابة مكانتش كفاية. فريق الدعم يقدر يساعدك أكتر.', 'Sorry that did not help. Our support team can help you further.'],
} as const;

/** The predefined FAQ assistant: every answer is a published FAQ from the database. */
@Injectable()
export class FaqAssistantProvider implements AssistantProvider {
  readonly name = 'faq';

  constructor(private readonly faq: FaqService) {}

  async welcome(context: AssistantContext): Promise<AssistantBlock[]> {
    const t = this.copy(context.language);
    return [{ type: 'text', text: `${t('welcome')}\n\n${t('abilities')}` }, ...(await this.menu(context.language))];
  }

  async respond(context: AssistantContext, input: AssistantInput): Promise<AssistantReply> {
    const t = this.copy(context.language);
    const reader = { userId: context.userId, restaurantId: context.restaurantId };
    switch (input.type) {
      case 'home':
        return { blocks: [{ type: 'text', text: t('home') }, ...(await this.menu(context.language))] };
      case 'question': {
        const article = await this.faq.article(input.articleId, reader, context.sessionId);
        return { echo: article.question, blocks: [{ type: 'answer', article }, { type: 'feedback', articleId: article.id }] };
      }
      case 'category': {
        const category = await this.faq.inCategory(context.language, input.slug);
        if (!category) return { blocks: [{ type: 'text', text: t('unknownCategory') }] };
        if (!category.items.length) return { echo: category.name, blocks: [{ type: 'text', text: t('emptyCategory') }] };
        return { echo: category.name, blocks: [{ type: 'suggestions', title: category.name, items: category.items }] };
      }
      case 'search':
      case 'message': {
        const query = input.type === 'search' ? input.query : input.text;
        const items = await this.faq.search(context.language, query, reader, undefined, context.sessionId);
        if (!items.length) return { echo: query, blocks: [{ type: 'text', text: t('noResults') }, { type: 'handoff', reason: 'NO_RESULTS' }] };
        return { echo: query, blocks: [{ type: 'results', query, items }] };
      }
      case 'human':
        // Reaching a person is handled before the provider (LiveChatService); offer it if asked here.
        return { blocks: [{ type: 'handoff', reason: 'REQUESTED' }] };
      case 'feedback': {
        await this.faq.feedback(input.articleId, input.helpful, reader, context.sessionId);
        return input.helpful
          ? { blocks: [{ type: 'text', text: t('thanks') }] }
          : { blocks: [{ type: 'text', text: t('sorry') }, { type: 'handoff', reason: 'NOT_HELPFUL' }] };
      }
    }
  }

  private async menu(language: SupportLanguage): Promise<AssistantBlock[]> {
    const t = this.copy(language);
    const [suggested, categories] = await Promise.all([this.faq.suggested(language), this.faq.categories(language)]);
    return [
      ...(suggested.length ? [{ type: 'suggestions' as const, title: t('suggested'), items: suggested }] : []),
      ...(categories.length ? [{ type: 'categories' as const, items: categories.map(({ slug, name, icon, articleCount }) => ({ slug, name, icon, articleCount })) }] : []),
    ];
  }

  private copy(language: SupportLanguage) {
    return (key: keyof typeof COPY) => COPY[key][language === 'ar' ? 0 : 1];
  }
}
