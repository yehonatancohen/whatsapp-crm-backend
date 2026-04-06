import { prisma } from '../../shared/db';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

export interface CreateTemplateData {
  name: string;
  content: string;
  category?: string;
}

export interface UpdateTemplateData {
  name?: string;
  content?: string;
  category?: string;
}

async function getOwnedTemplate(id: string, userId: string) {
  const template = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!template) throw new NotFoundError('Template');
  if (template.userId !== userId) throw new ForbiddenError('You do not own this template');
  return template;
}

/** Extract {{variable}} placeholders from template content */
function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '')))];
}

export async function listTemplates(userId: string, category?: string) {
  const where: Record<string, unknown> = { userId };
  if (category) where.category = category;

  return prisma.messageTemplate.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getTemplate(id: string, userId: string) {
  return getOwnedTemplate(id, userId);
}

export async function createTemplate(userId: string, data: CreateTemplateData) {
  const variables = extractVariables(data.content);

  return prisma.messageTemplate.create({
    data: {
      name: data.name,
      content: data.content,
      category: data.category || null,
      variables,
      userId,
    },
  });
}

export async function updateTemplate(id: string, userId: string, data: UpdateTemplateData) {
  await getOwnedTemplate(id, userId);

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.content !== undefined) {
    updateData.content = data.content;
    updateData.variables = extractVariables(data.content);
  }
  if (data.category !== undefined) updateData.category = data.category;

  return prisma.messageTemplate.update({
    where: { id },
    data: updateData,
  });
}

export async function deleteTemplate(id: string, userId: string) {
  await getOwnedTemplate(id, userId);
  await prisma.messageTemplate.delete({ where: { id } });
}

export async function listCategories(userId: string): Promise<string[]> {
  const results = await prisma.messageTemplate.findMany({
    where: { userId, category: { not: null } },
    select: { category: true },
    distinct: ['category'],
  });
  return results.map((r) => r.category!).filter(Boolean);
}
