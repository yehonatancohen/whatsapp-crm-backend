import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db';
import { normalizePhone } from './importService';

interface ListContactsParams {
  page?: number;
  limit?: number;
  search?: string;
  tags?: string[];
  userId?: string;
  isAdmin?: boolean;
}

export async function listContacts({ page = 1, limit = 50, search, tags, userId, isAdmin = false }: ListContactsParams) {
  const where: Prisma.ContactWhereInput = {};

  if (!isAdmin && userId) {
    where.listEntries = {
      some: { contactList: { userId } },
    };
  }

  if (search) {
    where.OR = [
      { phoneNumber: { contains: search } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (tags && tags.length > 0) {
    where.tags = { hasSome: tags };
  }

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contact.count({ where }),
  ]);

  return {
    contacts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function createContact(phoneNumber: string, name?: string, tags?: string[], userId?: string) {
  const normalized = normalizePhone(phoneNumber);
  const phone = normalized || phoneNumber;

  const contact = await prisma.contact.upsert({
    where: { phoneNumber: phone },
    create: { phoneNumber: phone, name: name || null, tags: tags || [] },
    update: {},
  });

  if (userId) {
    await addToDefaultList(contact.id, userId);
  }

  return contact;
}

async function addToDefaultList(contactId: string, userId: string) {
  let list = await prisma.contactList.findFirst({
    where: { userId, name: 'All Contacts' },
  });
  if (!list) {
    list = await prisma.contactList.create({
      data: { name: 'All Contacts', userId },
    });
  }
  await prisma.contactListEntry.upsert({
    where: { contactId_contactListId: { contactId, contactListId: list.id } },
    create: { contactId, contactListId: list.id },
    update: {},
  });
}

export async function updateContact(id: string, data: { name?: string; tags?: string[]; metadata?: any }) {
  return prisma.contact.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.tags !== undefined && { tags: data.tags }),
      ...(data.metadata !== undefined && { metadata: data.metadata }),
    },
  });
}

export async function deleteContact(id: string) {
  return prisma.contact.delete({ where: { id } });
}

// Contact Lists

export async function listContactLists(userId: string) {
  return prisma.contactList.findMany({
    where: { userId },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createContactList(userId: string, name: string, description?: string) {
  return prisma.contactList.create({
    data: { name, description: description || null, userId },
  });
}

export async function getContactListWithContacts(listId: string, userId: string) {
  return prisma.contactList.findFirst({
    where: { id: listId, userId },
    include: {
      entries: {
        include: { contact: true },
        orderBy: { addedAt: 'desc' },
      },
      _count: { select: { entries: true } },
    },
  });
}

export async function addContactsToList(listId: string, contactIds: string[]) {
  const data = contactIds.map((contactId) => ({
    contactId,
    contactListId: listId,
  }));

  await prisma.contactListEntry.createMany({
    data,
    skipDuplicates: true,
  });
}

export async function removeContactsFromList(listId: string, contactIds: string[]) {
  await prisma.contactListEntry.deleteMany({
    where: {
      contactListId: listId,
      contactId: { in: contactIds },
    },
  });
}
