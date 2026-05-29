
import prisma from "../lib/db.js";

/** A message row as returned by Prisma (content parsed back from JSON). */
interface ChatMessage {
  id: string;
  conversationId: string;
  role: string;
  content: any;
  createdAt: Date;
}

interface ConversationRecord {
  id: string;
  userId: string;
  title: string | null;
  mode: string;
  summary?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConversationWithMessages extends ConversationRecord {
  messages: ChatMessage[];
}

export class ChatService {
  /** Create a new conversation (`mode`: chat | tool). */
  private async createConversation(
    userId: string,
    mode = "chat",
    title: string | null = null
  ): Promise<ConversationRecord> {
    return (await prisma.conversation.create({
      data: {
        userId,
        mode,
        title: title || `New ${mode} conversation`,
      },
    })) as ConversationRecord;
  }

  /** Get an existing conversation (with messages) or create a new one. */
  async getOrCreateConversation(
    userId: string,
    conversationId: string | null = null,
    mode = "chat"
  ): Promise<ConversationWithMessages> {
    if (conversationId) {
      const conversation = (await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          userId,
        },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      })) as ConversationWithMessages | null;

      if (conversation) return conversation;
    }

    const created = (await this.createConversation(userId, mode)) as ConversationRecord;
    return { ...created, messages: [] };
  }

  /** Add a message; object content is stored as a JSON string. */
  async addMessage(
    conversationId: string,
    role: string,
    content: string | object
  ): Promise<ChatMessage> {
    const contentStr =
      typeof content === "string" ? content : JSON.stringify(content);

    return (await prisma.message.create({
      data: {
        conversationId,
        role,
        content: contentStr,
      },
    })) as ChatMessage;
  }

  /** Get conversation messages, parsing JSON content back to objects. */
  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((msg) => ({
      ...(msg as unknown as ChatMessage),
      content: this.parseContent((msg as any).content),
    }));
  }

  async updateTitle(conversationId: string, title: string) {
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { title },
    });
  }

  private parseContent(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  formatMessagesForAI(messages: ChatMessage[]): { role: string; content: string }[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    }));
  }
}
